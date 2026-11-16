import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const desktop = execSync('powershell -NoProfile -Command "[System.Environment]::GetFolderPath(\'Desktop\')"', { encoding: 'utf8' }).trim();
const projectDir = 'C:\\WMS-GITHUB\\amri\\development\\trueblue-wms';

console.log('Detected Desktop path:', desktop);

// 1. Shortcut Web App Live (.url)
const liveUrlContent = `[InternetShortcut]\nURL=https://trueblue-wms-web.onrender.com/\nIconIndex=0\n`;
fs.writeFileSync(path.join(desktop, 'TrueBlue WMS - Web App (Live).url'), liveUrlContent, 'utf8');

// 2. PowerShell script to create Windows .lnk shortcuts via COM
const psScript = `
$wsh = New-Object -ComObject WScript.Shell
$desktop = '${desktop.replace(/\\/g, '\\\\')}'
$project = '${projectDir.replace(/\\/g, '\\\\')}'

$s1 = $wsh.CreateShortcut("$desktop\\TrueBlue WMS - Folder Projek.lnk")
$s1.TargetPath = 'explorer.exe'
$s1.Arguments = $project
$s1.WorkingDirectory = $project
$s1.Description = 'Buka Folder Projek TrueBlue WMS'
$s1.Save()

$s2 = $wsh.CreateShortcut("$desktop\\TrueBlue WMS - Jalankan Lokal.lnk")
$s2.TargetPath = "$project\\JALANKAN_WMS_LOKAL.bat"
$s2.WorkingDirectory = $project
$s2.Description = 'Jalankan TrueBlue WMS Dev Server'
$s2.Save()
`;

execSync(`powershell -NoProfile -Command "${psScript.replace(/\n/g, '; ')}"`, { stdio: 'inherit' });
console.log('Desktop shortcuts created successfully in:', desktop);
