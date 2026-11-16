$desktop = [System.Environment]::GetFolderPath('Desktop')
$project = 'C:\WMS-GITHUB\amri\development\trueblue-wms'
$wsh = New-Object -ComObject WScript.Shell

# 1. Shortcut ke Folder Projek
$s1 = $wsh.CreateShortcut("$desktop\TrueBlue WMS - Folder Projek.lnk")
$s1.TargetPath = 'explorer.exe'
$s1.Arguments = $project
$s1.WorkingDirectory = $project
$s1.Description = 'Buka Folder Projek TrueBlue WMS'
$s1.Save()

# 2. Shortcut Jalankan Server Lokal
$s2 = $wsh.CreateShortcut("$desktop\TrueBlue WMS - Jalankan Lokal.lnk")
$s2.TargetPath = "$project\JALANKAN_WMS_LOKAL.bat"
$s2.WorkingDirectory = $project
$s2.Description = 'Jalankan TrueBlue WMS Dev Server'
$s2.Save()

# 3. Shortcut Web App Live (.url)
$urlContent = @"
[InternetShortcut]
URL=https://trueblue-wms-web.onrender.com/
IconIndex=0
"@
Set-Content -Path "$desktop\TrueBlue WMS - Web App (Live).url" -Value $urlContent

Write-Output "Shortcuts created on Desktop: $desktop"
