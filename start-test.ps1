$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

$port = 3001
Write-Host ""
Write-Host "DK Boutique - mode test local" -ForegroundColor Cyan
Write-Host "Dossier : $root"
Write-Host "Port    : $port"
Write-Host ""
Write-Host "Ouvre ensuite : http://localhost:$port" -ForegroundColor Green
Write-Host "Pour tester sur ton téléphone, utilise l'adresse IPv4 de ce PC sur le même Wi-Fi :" -ForegroundColor Yellow
Write-Host "http://ADRESSE_IP_DU_PC:$port"
Write-Host ""
Write-Host "Pour arrêter le serveur : CTRL + C"
Write-Host ""

function Command-Exists([string]$name) {
  return $null -ne (Get-Command $name -ErrorAction SilentlyContinue)
}

if (Command-Exists "python") {
  python -m http.server $port --bind 0.0.0.0
  exit $LASTEXITCODE
}

if (Command-Exists "py") {
  py -m http.server $port --bind 0.0.0.0
  exit $LASTEXITCODE
}

if (Command-Exists "npx") {
  npx --yes serve . -l $port
  exit $LASTEXITCODE
}

Write-Host "Python ou Node.js est requis pour lancer le serveur local." -ForegroundColor Red
Write-Host "Installe Python ou Node.js puis relance ce fichier."
exit 1
