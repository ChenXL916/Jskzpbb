$ErrorActionPreference = 'Stop'
$containers = @(
  'jishi-scheduling-postgres-1',
  'jishi-scheduling-redis-1',
  'jishi-scheduling-minio-1'
)

for ($attempt = 0; $attempt -lt 30; $attempt += 1) {
  & wsl.exe -d Ubuntu-24.04 -- docker info *> $null
  if ($LASTEXITCODE -eq 0) {
    break
  }
  Start-Sleep -Seconds 1
}

if ($LASTEXITCODE -ne 0) {
  throw 'Docker did not become available in Ubuntu-24.04.'
}

& wsl.exe -d Ubuntu-24.04 -- docker start $containers *> $null
if ($LASTEXITCODE -ne 0) {
  throw 'Failed to start the scheduling infrastructure containers.'
}

# Keep WSL alive so its Docker containers remain available to the local API.
& wsl.exe -d Ubuntu-24.04 -- sh -lc 'exec sleep infinity'
