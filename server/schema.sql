IF OBJECT_ID(N'dbo.ClassroomRecords', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.ClassroomRecords (
    id nvarchar(100) NOT NULL PRIMARY KEY,
    kind nvarchar(10) NOT NULL,
    ownerId nvarchar(200) NOT NULL,
    createdAt nvarchar(30) NOT NULL,
    payload nvarchar(max) NOT NULL,
    CONSTRAINT CK_ClassroomRecords_Json CHECK (ISJSON(payload) = 1),
    CONSTRAINT CK_ClassroomRecords_Kind CHECK (kind IN ('quiz', 'game'))
  );
  CREATE INDEX IX_ClassroomRecords_Owner
    ON dbo.ClassroomRecords (ownerId, kind, createdAt);
END;
