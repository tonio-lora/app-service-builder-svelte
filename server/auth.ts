import type { Request } from 'express'
import type { Identity } from '../src/lib/types.js'
import { HttpError, requireValue } from './errors.js'

export interface AuthConfig {
  domain: string
  professors: string[]
  development: boolean
}

export function readIdentity(request: Request, config: AuthConfig): Identity {
  let email: string
  let id: string
  let name: string
  if (config.development) {
    const user = request.get('x-dev-user') || 'professor'
    const users: Record<string, { email: string; name: string }> = {
      professor: { email: config.professors[0], name: 'Professor (local demo)' },
      'student-1': { email: `student1@${config.domain}`, name: 'Student One' },
      'student-2': { email: `student2@${config.domain}`, name: 'Student Two' },
      outsider: { email: 'visitor@example.org', name: 'Outside account' },
    }
    requireValue(users[user], 401, 'Unknown local demo account.')
    ;({ email, name } = users[user])
    id = `local:${email}`
  } else {
    requireValue(request.get('x-ms-client-principal-idp') === 'aad', 401, 'Sign in with your Iowa State Microsoft account.')
    const principalId = request.get('x-ms-client-principal-id')
    const encoded = request.get('x-ms-client-principal')
    requireValue(principalId && encoded, 401, 'Verified sign-in information is missing.')
    let principal: { claims?: { typ: string; val: string }[] }
    try {
      principal = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'))
    } catch {
      throw new HttpError(401, 'Invalid sign-in information. Sign out and sign in again.')
    }
    requireValue(principal && Array.isArray(principal.claims)
      && principal.claims.every((claim) => claim && typeof claim.typ === 'string' && typeof claim.val === 'string'),
    401, 'Verified identity claims are missing.')
    const claim = (...types: string[]) => types.map((type) =>
      principal.claims!.find((item) => item.typ === type)?.val).find(Boolean)
    const tenant = claim('http://schemas.microsoft.com/identity/claims/tenantid', 'tid')
    requireValue(tenant, 401, 'A verified Microsoft tenant is required.')
    email = claim('http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress',
      'email', 'preferred_username', 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/upn')
      || request.get('x-ms-client-principal-name') || ''
    name = claim('name', 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name') || email.split('@')[0]
    id = `aad:${tenant}:${principalId}`
  }
  email = email.trim().toLowerCase()
  requireValue(email.split('@').length === 2 && email.split('@')[1] === config.domain,
    403, `Only @${config.domain} accounts can access this classroom.`)
  return { id, email, name: name.slice(0, 80), professor: config.professors.includes(email), development: config.development }
}
