$desktop = [System.Environment]::GetFolderPath('Desktop')
$project = 'C:\WMS-GITHUB\amri\development\trueblue-wms'
$codeExe = "$env:LOCALAPPDATA\Programs\Microsoft VS Code\Code.exe"
$wsh = New-Object -ComObject WScript.Shell

# Shortcut Buka di VS Code
$s = $wsh.CreateShortcut("$desktop\TrueBlue WMS - Buka di VS Code.lnk")
$s.TargetPath = $codeExe
$s.Arguments = "`"$project`""
$s.WorkingDirectory = $project
$s.IconLocation = "$codeExe,0"
$s.Description = "Buka Proyek TrueBlue WMS di Visual Studio Code"
$s.Save()

Write-Output "VS Code Shortcut created on Desktop: $desktop\TrueBlue WMS - Buka di VS Code.lnk"
