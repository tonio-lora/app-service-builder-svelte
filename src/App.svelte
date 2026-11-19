<script lang="ts">
  import { onMount } from 'svelte'
  import QRCode from 'qrcode'
  import { api, apiText, ApiError, messageOf } from './lib/api'
  import type { Choice, GameSummary, GameView, Identity, QuizSummary } from './lib/types'

  let user = $state<Identity | null>(null)
  let quizzes = $state<QuizSummary[]>([])
  let games = $state<GameSummary[]>([])
  let game = $state<GameView | null>(null)
  let path = $state(window.location.pathname)
  let loading = $state(true)
  let busy = $state(false)
  let error = $state('')
  let syncError = $state('')
  let notice = $state('')
  let title = $state('')
  let file = $state<File | null>(null)
  let fileInput = $state<HTMLInputElement>()
  let joinCode = $state('')
  let displayName = $state('')
  let selected = $state<Choice | ''>('')
  let demoUser = $state(localStorage.getItem('classroom-demo-user') || 'professor')
  let qr = $state('')
  let qrError = $state('')
  let clock = $state(Date.now())
  let offset = $state(0)
  let polling = false
  let generation = 0
  const letters: Choice[] = ['A', 'B', 'C', 'D']
  const routeCode = $derived(/^\/(?:j|host)\/([a-z0-9]{6})\/?$/i.exec(path)?.[1]?.toUpperCase() || '')
  const validPath = $derived(path === '/' || Boolean(routeCode))
  const joinUrl = $derived(game?.isHost ? `${window.location.origin}/j/${game.code}` : '')
  const seconds = $derived(game?.deadline && game.question
    ? Math.min(game.question.seconds, Math.max(0, Math.ceil((game.deadline - clock - offset) / 1000))) : 0)
  const myEntry = $derived(game?.leaderboard.find((entry) => entry.isMe))

  $effect(() => {
    const url = joinUrl
    let active = true
    qr = ''
    qrError = ''
    if (url) {
      QRCode.toDataURL(url, { width: 224, margin: 2, color: { dark: '#192a32', light: '#ffffff' } })
        .then((value) => { if (active) qr = value })
        .catch((cause) => { if (active) qrError = `QR generation failed: ${messageOf(cause)}. Use the join link or code.` })
    }
    return () => { active = false }
  })

  function acceptGame(value: GameView) {
    if (game?.code === value.code && (value.revision < game.revision || value.serverNow < game.serverNow)) return
    if (game?.question?.id !== value.question?.id) selected = ''
    if (value.submittedChoice) selected = value.submittedChoice
    clock = Date.now()
    offset = value.serverNow - clock
    game = value
  }

  async function loadPage() {
    const currentGeneration = ++generation
    loading = true
    error = ''
    syncError = ''
    game = null
    selected = ''
    try {
      const identity = await api<Identity>('/me')
      if (currentGeneration !== generation) return
      user = identity
      displayName ||= identity.name.slice(0, 40)
      if (routeCode) {
        joinCode = routeCode
        try {
          const value = await api<GameView>(`/games/${routeCode}`)
          if (currentGeneration === generation) acceptGame(value)
        } catch (cause) {
          // A student without a seat must explicitly join and choose a display name.
          if (!(cause instanceof ApiError && cause.status === 403 && !identity.professor)) throw cause
        }
      } else if (identity.professor && path === '/') {
        const [quizList, gameList] = await Promise.all([api<QuizSummary[]>('/quizzes'), api<GameSummary[]>('/games')])
        if (currentGeneration !== generation) return
        quizzes = quizList
        games = gameList
      }
    } catch (cause) {
      if (currentGeneration === generation) error = messageOf(cause)
    } finally {
      if (currentGeneration === generation) loading = false
    }
  }

  function go(destination: string) {
    window.history.pushState({}, '', destination)
    path = window.location.pathname
    notice = ''
    void loadPage()
  }

  async function refresh() {
    if (!game || busy || polling) return
    const code = game.code
    const currentGeneration = generation
    polling = true
    try {
      const value = await api<GameView>(`/games/${code}`)
      if (currentGeneration === generation) {
        acceptGame(value)
        syncError = ''
      }
    } catch (cause) {
      if (currentGeneration === generation) syncError = `Connection interrupted: ${messageOf(cause)} Retrying automatically.`
    } finally {
      polling = false
    }
  }

  async function run(action: () => Promise<void>) {
    if (busy) return
    busy = true
    error = ''
    notice = ''
    try { await action() }
    catch (cause) { error = messageOf(cause) }
    finally { busy = false }
  }

  async function upload() {
    await run(async () => {
      if (!file) throw new Error('Choose a CSV file first.')
      if (file.size > 512000) throw new Error('Choose a CSV file smaller than 500 KB.')
      const imported = await api<{ title: string; questionCount: number }>('/quizzes', { title, csv: await file.text() })
      quizzes = await api<QuizSummary[]>('/quizzes')
      notice = `Imported "${imported.title}" with ${imported.questionCount} questions. Ready to host!`
      title = ''
      file = null
      if (fileInput) fileInput.value = ''
    })
  }

  function pickFile(event: Event) {
    const input = event.currentTarget as HTMLInputElement
    file = input.files?.[0] || null
    if (file && !title) title = file.name.replace(/\.csv$/i, '').replace(/[-_]/g, ' ')
  }

  async function host(quizId: string) {
    await run(async () => {
      const value = await api<GameView>('/games', { quizId })
      go(`/host/${value.code}`)
    })
  }

  async function joinCompetition() {
    await run(async () => {
      const code = joinCode.trim().toUpperCase()
      if (!/^[A-HJ-NP-Z2-9]{6}$/.test(code)) throw new Error('Enter the six-character code shown by your professor.')
      const value = await api<GameView>(`/games/${code}/join`, { name: displayName })
      window.history.pushState({}, '', `/j/${code}`)
      path = window.location.pathname
      generation++
      acceptGame(value)
    })
  }

  async function control(action: string) {
    if (!game) return
    if (action === 'finish' && !window.confirm('End this competition now? Unanswered questions will receive zero points.')) return
    const current = game
    await run(async () => { acceptGame(await api<GameView>(`/games/${current.code}/control`, { action, revision: current.revision })) })
  }

  async function submitAnswer() {
    if (!game?.question || !selected) return
    const current = game
    await run(async () => {
      acceptGame(await api<GameView>(`/games/${current.code}/answers`, { questionId: current.question!.id, choice: selected }))
    })
  }

  async function copyLink() {
    await run(async () => {
      await navigator.clipboard.writeText(joinUrl)
      notice = 'Join link copied.'
    })
  }

  async function downloadResults() {
    if (!game) return
    const code = game.code
    await run(async () => {
      const csv = await apiText(`/games/${code}/results.csv`)
      const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
      const link = document.createElement('a')
      link.href = url
      link.download = `classroom-${code}.csv`
      link.click()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    })
  }

  async function switchDemo() {
    localStorage.setItem('classroom-demo-user', demoUser)
    user = null
    displayName = ''
    await loadPage()
  }

  onMount(() => {
    void loadPage()
    const timer = setInterval(() => { clock = Date.now() }, 200)
    const poll = setInterval(() => { void refresh() }, 1000)
    return () => { generation++; clearInterval(timer); clearInterval(poll) }
  })
</script>

<svelte:window onpopstate={() => { path = window.location.pathname; void loadPage() }} />

<div class="app-shell">
  <header class="topbar">
    <button class="brand" onclick={() => go('/')} aria-label="Cyclone Classroom home">
      <span class="brand-mark" aria-hidden="true">C<span>↗</span></span>
      <span>Cyclone<span class="brand-sub">CLASSROOM</span></span>
    </button>
    <div class="account">
      <span class="role-badge">{user?.professor ? 'Professor workspace' : 'Student workspace'}</span>
      {#if user}<span class="account-email">{user.email}</span>{#if !user.development}<a class="quiet-link" href="/.auth/logout">Sign out</a>{/if}{/if}
    </div>
  </header>

  {#if user?.development}
    <aside class="demo-banner" aria-label="Local demonstration mode">
      <strong>LOCAL DEMO</strong><span>Simulated sign-in. Not connected to Azure SQL.</span>
      <label>Test as
        <select bind:value={demoUser} onchange={switchDemo} disabled={busy}>
          <option value="professor">Professor</option><option value="student-1">Student One</option>
          <option value="student-2">Student Two</option><option value="outsider">Outside domain (blocked)</option>
        </select>
      </label>
    </aside>
  {/if}

  <main>
    {#if error}<div class="alert error" role="alert">{error} <button class="text-button" onclick={() => void loadPage()}>Reload</button></div>{/if}
    {#if syncError}<div class="alert error" role="alert">{syncError} Answers are accepted only when confirmed by the server.</div>{/if}
    {#if notice}<div class="alert success" role="status">{notice}</div>{/if}

    {#if loading}
      <section class="empty-state card"><div class="spinner"></div><h1>Opening your classroom...</h1></section>
    {:else if !user}
      <section class="welcome card">
        <p class="eyebrow">IOWA STATE · LIVE LEARNING</p>
        <h1>Your next great<br />class discussion starts here.</h1>
        <p>Sign in with your Iowa State account to host or join a live quiz.</p>
        <a class="button primary" href={`/.auth/login/aad?post_login_redirect_uri=${encodeURIComponent(path)}`}>Sign in with Iowa State</a>
        {#if import.meta.env.DEV}
          <button class="button secondary" onclick={() => { demoUser = 'professor'; void switchDemo() }}>Reset local demo account</button>
        {/if}
        <p class="fine-print">Access is restricted to verified @iastate.edu accounts.</p>
      </section>
    {:else if !validPath}
      <section class="empty-state card"><h1>Page not found</h1><p>Use your professor's join link or return to your workspace.</p><button class="primary" onclick={() => go('/')}>Go home</button></section>
    {:else if game}
      <div class="page-heading game-heading">
        <div><p class="eyebrow">{game.isHost ? 'LIVE COMPETITION · HOST VIEW' : 'LIVE COMPETITION'}</p><h1>{game.title}</h1>
          <p>{game.phase === 'finished' ? 'Competition complete. Well played!' : game.phase === 'lobby' ? 'A little friendly competition. A lot of learning.' : `Question ${game.questionNumber} of ${game.questionCount}`}</p></div>
        <div class="live-pill"><span class:ended={game.phase === 'finished'}></span>{game.phase === 'finished' ? 'Finished' : game.phase === 'lobby' ? 'Lobby open' : 'In progress'} · {game.code}</div>
      </div>

      <div class="competition-layout" class:student-layout={!game.isHost}>
        <div class="main-column">
          {#if game.phase === 'lobby'}
            <section class="card lobby-card">
              <span class="section-label">{game.isHost ? '01 / INVITE YOUR CLASS' : 'YOU HAVE A SEAT'}</span>
              <h2>{game.isHost ? 'Scan. Sign in. Game on.' : `You're in, ${displayName || user.name}!`}</h2>
              <p>{game.isHost ? 'Students can scan this code with their phone or enter the join code from any browser.' : 'Keep this screen open. Your professor will start the first question when everyone is ready.'}</p>
              {#if game.isHost}
                <div class="join-share">
                  <div class="qr-frame">
                    {#if qr}<img src={qr} alt={`QR code to join competition ${game.code}`} width="224" height="224" />{:else}<span>Preparing QR code...</span>{/if}
                  </div>
                  <div class="join-details"><span class="section-label">JOIN CODE</span><div class="big-code">{game.code}</div>
                    <a class="join-url" href={joinUrl}>{joinUrl}</a>
                    <button class="secondary small" onclick={copyLink} disabled={busy}>Copy join link</button>
                    <p class="fine-print">Iowa State sign-in required. Joining closes when the competition starts.</p>
                  </div>
                </div>
                {#if qrError}<p class="inline-error" role="alert">{qrError}</p>{/if}
              {:else}
                <div class="waiting-icon" aria-hidden="true">✓</div>
                <p class="waiting-text"><span class="pulse-dot"></span> Waiting for the professor to start...</p>
              {/if}
              <div class="lobby-bottom"><span><strong>{game.participantCount}</strong> students ready · {game.questionCount} questions</span>
                {#if game.isHost}<button class="primary" onclick={() => control('start')} disabled={busy || game.participantCount === 0}>Start competition →</button>{/if}
              </div>
            </section>
          {:else if game.phase === 'finished'}
            <section class="card finished-card">
              <div class="trophy" aria-hidden="true">★</div><p class="eyebrow">THAT'S A WRAP</p><h2>Knowledge wins.</h2>
              {#if myEntry}<p>You finished <strong>#{myEntry.rank}</strong> with <strong>{myEntry.points.toLocaleString()} points.</strong></p>
              {:else}<p>{game.participantCount} students. {game.questionCount} questions. One great class.</p>{/if}
              {#if game.leaderboard[0]}<div class="winner"><span class="section-label">TOP OF THE CLASS</span><h3>{game.leaderboard[0].name}</h3><span>{game.leaderboard[0].points.toLocaleString()} points{game.leaderboard.filter((entry) => entry.rank === 1).length > 1 ? ' · tied first place' : ''}</span></div>{/if}
              {#if game.isHost}<button class="primary" onclick={downloadResults} disabled={busy}>Download results CSV ↓</button>{/if}
              <button class="secondary" onclick={() => go('/')}>Back to workspace</button>
            </section>
          {:else if game.question}
            <section class="card question-card">
              <div class="question-top"><span class="section-label">QUESTION {String(game.questionNumber).padStart(2, '0')} / {String(game.questionCount).padStart(2, '0')}</span>
                <div class="timer" class:urgent={seconds <= 5 && game.phase === 'question'} aria-label={game.phase === 'reveal' ? 'Round closed' : `${seconds} seconds remaining`}>{game.phase === 'reveal' ? 'Round closed' : `${seconds}s`}</div></div>
              <div class="timer-track" role="progressbar" aria-label="Time remaining" aria-valuenow={game.phase === 'question' ? seconds : 0} aria-valuemin="0" aria-valuemax={game.question.seconds}>
                <span style:width={`${game.phase === 'question' ? seconds / game.question.seconds * 100 : 0}%`}></span>
              </div>
              <h2 class="question-text">{game.question.text}</h2>
              <fieldset class="answer-grid" disabled={game.isHost || busy || Boolean(game.submittedChoice) || game.phase !== 'question' || seconds === 0 || Boolean(syncError)}>
                <legend class="sr-only">Choose one answer</legend>
                {#each letters as letter}
                  <label class="answer-option" class:chosen={selected === letter || game.submittedChoice === letter}
                    class:correct={game.correctAnswer === letter}
                    class:incorrect={game.phase === 'reveal' && game.submittedChoice === letter && game.correctAnswer !== letter}>
                    <input type="radio" name="answer" value={letter} bind:group={selected} />
                    <span class="option-letter">{letter}</span><span>{game.question.options[letter]}</span>
                    {#if game.correctAnswer === letter}<span class="answer-indicator" aria-label="Correct answer">✓</span>{/if}
                  </label>
                {/each}
              </fieldset>
              <div class="answer-footer" aria-live="polite">
                {#if game.phase === 'reveal'}
                  <p class="reveal-text">{game.isHost ? `Correct answer: ${game.correctAnswer}` : game.submittedChoice === game.correctAnswer ? 'Correct! Nicely done.' : game.submittedChoice ? `The correct answer was ${game.correctAnswer}. On to the next one!` : `Time's up. The correct answer was ${game.correctAnswer}.`}</p>
                  {#if !game.isHost}<p class="fine-print">Waiting for the professor to continue...</p>{/if}
                {:else if game.isHost}<p><strong>{game.answeredCount} / {game.participantCount}</strong> answers received</p>
                {:else if game.submittedChoice}<p class="locked-answer">✓ Answer {game.submittedChoice} locked in. Waiting for the reveal...</p>
                {:else if seconds === 0}<p>Time's up. Waiting for the server to reveal the answer...</p>
                {:else}<button class="primary submit-answer" onclick={submitAnswer} disabled={!selected || busy || Boolean(syncError)}>{busy ? 'Submitting...' : 'Lock in my answer →'}</button><p class="fine-print">One answer per question. Once submitted, it cannot be changed.</p>{/if}
              </div>
              {#if game.isHost}
                <div class="host-controls">
                  {#if game.phase === 'question'}<button class="secondary" onclick={() => control('close')} disabled={busy}>Close question & reveal</button>
                  {:else}<button class="primary" onclick={() => control('next')} disabled={busy}>{game.questionNumber === game.questionCount ? 'Finish & show results →' : 'Next question →'}</button>{/if}
                </div>
              {/if}
            </section>
          {/if}

          {#if game.isHost && game.phase !== 'finished'}
            <div class="session-tools"><button class="text-button" onclick={downloadResults} disabled={busy}>Export results ↓</button><button class="text-button danger" onclick={() => control('finish')} disabled={busy}>End competition</button></div>
          {/if}
          <p class="scoring-note">Correct answers earn 500 points + up to 500 speed points. Wrong or missed answers earn 0. Scores appear after each reveal.</p>
        </div>
        <aside class="side-column">
          <section class="card leaderboard">
            <div class="card-title"><h2>{game.phase === 'lobby' ? 'The class is gathering' : game.phase === 'finished' ? 'Final leaderboard' : 'Leaderboard'}</h2><span class="count-badge">{game.participantCount}</span></div>
            {#if game.phase === 'question'}<p class="fine-print">Scores through the previous round.</p>{/if}
            {#if !game.leaderboard.length}<div class="empty-small"><span aria-hidden="true">◎</span><p>Your students will appear here<br />when they join.</p></div>
            {:else}<ol class="ranking-list">{#each game.leaderboard as entry, index}<li class:my-rank={entry.isMe}><span class="rank">{game.phase === 'lobby' ? String(index + 1).padStart(2, '0') : entry.rank}</span><span class="rank-name">{entry.name}{#if entry.isMe}<small>YOU</small>{/if}</span><strong>{game.phase === 'lobby' ? '✓' : entry.points.toLocaleString()}</strong></li>{/each}</ol>{/if}
          </section>
          {#if game.isHost && game.roster.length}
            <section class="card roster"><h2>Professor roster</h2><p class="fine-print">Account details are visible only to you.</p>{#each game.roster as student}<div class="roster-row"><span><strong>{student.name}</strong><small>{student.email}</small></span><span aria-label={student.answered ? 'Answered' : 'Not answered'}>{student.answered ? '✓' : '—'}</span></div>{/each}</section>
          {/if}
          <div class="tip-card"><span class="section-label">BUILT FOR THE CLASSROOM</span><p>{game.isHost ? 'Project this screen while students answer on their phones or laptops.' : 'Stay on this page. Questions and results update automatically.'}</p></div>
        </aside>
      </div>
    {:else if user.professor && path === '/'}
      <div class="page-heading"><div><p class="eyebrow">LESS LECTURE. MORE PARTICIPATION.</p><h1>Bring your classroom to life.</h1><p>Your questions. A live challenge. Every student in the game.</p></div><div class="date-label">PROFESSOR DASHBOARD<span>Ready when your class is.</span></div></div>
      <div class="dashboard-grid">
        <section class="card import-card">
          <span class="section-label">01 / BUILD YOUR QUESTION BANK</span><h2>A good question changes everything.</h2><p>Upload your multiple-choice questions and turn them into a live competition.</p>
          <form onsubmit={(event) => { event.preventDefault(); void upload() }}>
            <label class="field-label" for="quiz-title">Quiz title</label><input id="quiz-title" bind:value={title} maxlength="100" placeholder="e.g. Week 4 · Fundamentals" required />
            <label class="upload-zone" for="csv-file"><span class="upload-icon" aria-hidden="true">↑</span><strong>{file ? file.name : 'Choose your questions CSV'}</strong><span>4 answer choices · 1 correct answer · up to 100 questions</span><input bind:this={fileInput} id="csv-file" type="file" accept=".csv,text/csv" onchange={pickFile} required /></label>
            <div class="import-actions"><a class="quiet-link" href="/sample-questions.csv" download>Download example CSV ↓</a><button type="submit" class="primary" disabled={busy}>{busy ? 'Importing...' : 'Import questions →'}</button></div>
          </form>
          <details class="csv-help"><summary>CSV format & timing</summary><p>Use these exact headers:</p><code>question,option_a,option_b,option_c,option_d,correct_answer,time_limit_seconds</code><p>Correct answer: A-D. Timer: 5-120 seconds per question. Quote fields containing commas or newlines. Uploads are validated before saving.</p></details>
        </section>
        <section class="card library-card"><div class="card-title"><div><span class="section-label">02 / PICK A QUIZ & GO LIVE</span><h2>Your question bank</h2></div><span class="count-badge">{quizzes.length}</span></div>
          {#if quizzes.length}<div class="quiz-list">{#each quizzes as quiz}<div class="quiz-row"><div class="quiz-icon" aria-hidden="true">≡</div><div class="quiz-info"><h3>{quiz.title}</h3><p>{quiz.questionCount} questions · {new Date(quiz.createdAt).toLocaleDateString()}</p></div><button class="secondary small" onclick={() => host(quiz.id)} disabled={busy}>Host quiz →</button></div>{/each}</div>
          {:else}<div class="empty-small library-empty"><span aria-hidden="true">≡</span><h3>A fresh start.</h3><p>Import your first CSV to get your<br />question bank ready for class.</p></div>{/if}
          <div class="how-it-works"><span class="section-label">FROM QUESTIONS TO COMPETITION</span><ol><li><b>1</b>Import CSV</li><li><b>2</b>Share QR code</li><li><b>3</b>Play together</li></ol></div>
        </section>
      </div>
      <section class="card history-card"><div class="card-title"><div><span class="section-label">KEEP THE MOMENTUM</span><h2>Your competitions</h2></div><button class="text-button" onclick={() => void loadPage()} disabled={busy}>Refresh ↻</button></div>
        {#if games.length}<div class="game-list">{#each games as session}<button class="game-row" onclick={() => go(`/host/${session.code}`)}><span class="history-dot" class:complete={session.phase === 'finished'}></span><span class="quiz-info"><strong>{session.title}</strong><small>{session.code} · {new Date(session.createdAt).toLocaleString()}</small></span><span class="history-meta">{session.participantCount} students</span><span class="status-tag">{session.phase === 'question' || session.phase === 'reveal' ? 'In progress' : session.phase}</span><span aria-hidden="true">↗</span></button>{/each}</div>
        {:else}<p class="muted">No competitions yet. Host a quiz to open your first lobby.</p>{/if}
      </section>
    {:else}
      <section class="student-welcome">
        <div class="student-intro"><p class="eyebrow">THINK FAST. LEARN TOGETHER.</p><h1>Ready to<br />raise the bar?</h1><p>Join your professor's live quiz.<br />Bring your curiosity. We'll bring the countdown.</p><div class="student-features"><span>✓ No app to install</span><span>✓ Phone or laptop</span><span>✓ Live leaderboard</span></div></div>
        <section class="card join-card"><span class="section-label">YOUR CLASSROOM IS ONE CODE AWAY</span><h2>Join the competition.</h2><p>Enter the code on your professor's screen.</p>
          <form onsubmit={(event) => { event.preventDefault(); void joinCompetition() }}>
            <label class="field-label" for="join-code">Join code</label><input id="join-code" class="code-input" bind:value={joinCode} placeholder="ABC234" maxlength="6" minlength="6" autocomplete="off" autocapitalize="characters" spellcheck="false" required />
            <label class="field-label" for="display-name">Leaderboard display name</label><input id="display-name" bind:value={displayName} maxlength="40" placeholder="How should we call you?" required />
            <p class="fine-print">Your display name is visible to the class. Your verified email is visible only to the professor.</p><button class="primary full-width" type="submit" disabled={busy}>{busy ? 'Joining...' : "Let's play →"}</button>
          </form>
          <div class="verified-note">✓ Signed in with your Iowa State account</div>
        </section>
      </section>
    {/if}
  </main>
  <footer><span>Cyclone Classroom</span><span>Made for curious minds. Built for a little friendly competition.</span><span>IOWA STATE · @iastate.edu</span></footer>
</div>
