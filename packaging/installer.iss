; Inno Setup のインストーラー設定。packaging/build.ps1 から /DAppVersion=x.y.z を付けて使う。
; 管理者権限なしで、ユーザーごとに %LOCALAPPDATA%\Programs\SR-MK1 for PC へ入れる。
; 設定・履歴 (%APPDATA%\SR-MK1 for PC) はアンインストールしても残す。

#define AppName "SR-MK1 for PC"
#define AppExe AppName + ".exe"
#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif

[Setup]
AppId={{2CF0AE2E-C2DB-4D6A-8D58-6910332DC61C}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher={#AppName} (非公式)
AppComments=テプラ PRO SR-MK1 を Windows パソコンから使うためのラベル作成アプリ (非公式)
DefaultDirName={autopf}\{#AppName}
DisableProgramGroupPage=yes
DisableDirPage=auto
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0.17763
OutputDir=..\dist
OutputBaseFilename=SR-MK1-for-PC-{#AppVersion}-setup
SetupIconFile=app.ico
UninstallDisplayIcon={app}\{#AppExe}
UninstallDisplayName={#AppName}
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
CloseApplications=yes

[Languages]
Name: "ja"; MessagesFile: "compiler:Languages\Japanese.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"

[InstallDelete]
; 上書きインストールのとき、前の版の古いファイルが残らないようにする
Type: filesandordirs; Name: "{app}\_internal"

[Files]
Source: "..\dist\{#AppName}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\{#AppName}"; Filename: "{app}\{#AppExe}"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\{#AppExe}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#AppExe}"; Description: "{cm:LaunchProgram,{#AppName}}"; Flags: nowait postinstall skipifsilent
