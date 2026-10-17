param(
  [string]$NodePath = 'C:\Users\Julian\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe',
  [ValidateRange(1024, 65535)][int]$HttpsPort = 3443,
  [ValidateRange(1024, 65535)][int]$UpstreamPort = 3188
)
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$stateRoot = Join-Path $repoRoot 'work\local-https'
if (-not (Test-Path -LiteralPath (Join-Path $repoRoot '.next\BUILD_ID'))) { throw 'Build Bundle first.' }
if (-not (Test-Path -LiteralPath $NodePath)) { throw 'Pass -NodePath pointing to Node 24.' }
if ((& $NodePath --version) -notmatch '^v24\.') { throw 'Use Node 24 for this project.' }
New-Item -ItemType Directory -Force -Path $stateRoot | Out-Null
$manifestPath = Join-Path $stateRoot 'certificate.json'
$passwordPath = Join-Path $stateRoot 'password.clixml'
$pfxPath = Join-Path $stateRoot 'localhost.pfx'
$cerPath = Join-Path $stateRoot 'localhost.cer'
if (-not (Test-Path -LiteralPath $manifestPath)) {
  $certificate = New-SelfSignedCertificate -Type SSLServerAuthentication -DnsName localhost -CertStoreLocation 'Cert:\CurrentUser\My' -FriendlyName 'Bundle loopback HTTPS verification' -KeyExportPolicy Exportable -KeyAlgorithm RSA -KeyLength 2048 -HashAlgorithm SHA256 -NotAfter (Get-Date).AddDays(30)
  $random = New-Object byte[] 32
  [System.Security.Cryptography.RandomNumberGenerator]::Fill($random)
  $securePassword = ConvertTo-SecureString ([Convert]::ToBase64String($random)) -AsPlainText -Force
  $securePassword | Export-Clixml -LiteralPath $passwordPath
  Export-PfxCertificate -Cert $certificate -FilePath $pfxPath -Password $securePassword | Out-Null
  Export-Certificate -Cert $certificate -FilePath $cerPath | Out-Null
  Import-Certificate -FilePath $cerPath -CertStoreLocation 'Cert:\CurrentUser\Root' | Out-Null
  @{ thumbprint = $certificate.Thumbprint; expiresAt = $certificate.NotAfter.ToUniversalTime().ToString('o'); subject = 'localhost' } | ConvertTo-Json | Set-Content -LiteralPath $manifestPath
} else {
  $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
  if ($manifest.thumbprint -notmatch '^[A-F0-9]{40}$') { throw 'Invalid local certificate manifest.' }
  $certificate = Get-Item -LiteralPath ('Cert:\CurrentUser\My\' + $manifest.thumbprint)
  if ($certificate.NotAfter -le (Get-Date) -or -not $certificate.HasPrivateKey) { throw 'Bundle local certificate expired or unavailable.' }
  if (-not (Test-Path -LiteralPath ('Cert:\CurrentUser\Root\' + $manifest.thumbprint))) { throw 'Bundle local certificate is not trusted. Reinstall its public certificate in the CurrentUser Root store.' }
  $securePassword = Import-Clixml -LiteralPath $passwordPath
}
# The PFX is encrypted; its password is DPAPI-bound to this Windows user.
# Never print either value or copy environment/production credentials.
$previousPassword = $env:BUNDLE_LOCAL_TLS_PASSPHRASE
$previousHttpsPort = $env:BUNDLE_LOCAL_HTTPS_PORT
$previousUpstreamPort = $env:BUNDLE_LOCAL_UPSTREAM_PORT
try {
  $env:BUNDLE_LOCAL_TLS_PASSPHRASE = [System.Net.NetworkCredential]::new('', $securePassword).Password
  $env:BUNDLE_LOCAL_HTTPS_PORT = [string]$HttpsPort
  $env:BUNDLE_LOCAL_UPSTREAM_PORT = [string]$UpstreamPort
  Push-Location $repoRoot
  try { & $NodePath (Join-Path $PSScriptRoot 'local-https.mjs') } finally { Pop-Location }
} finally {
  $env:BUNDLE_LOCAL_TLS_PASSPHRASE = $previousPassword
  $env:BUNDLE_LOCAL_HTTPS_PORT = $previousHttpsPort
  $env:BUNDLE_LOCAL_UPSTREAM_PORT = $previousUpstreamPort
}
