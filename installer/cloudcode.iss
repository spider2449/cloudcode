#define AppName "cloudcode"
#define AppVersion "0.1.0"

[Setup]
AppId={{B7E4C1D2-5A3F-4E8B-9C6D-0F1A2B3C4D5E}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher=spider
DefaultDirName={autopf}\cloudcode
DefaultGroupName=cloudcode
DisableProgramGroupPage=yes
OutputDir=..\release
OutputBaseFilename=cloudcode-setup-{#AppVersion}
Compression=lzma2
SolidCompression=yes
ArchitecturesInstallIn64BitMode=x64compatible
ChangesEnvironment=yes
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog

[Files]
Source: "..\release\cloudcode-win-x64.exe"; DestDir: "{app}"; DestName: "cloudcode.exe"; Flags: ignoreversion

[Registry]
; Append install dir to the user PATH if not already present.
Root: HKCU; Subkey: "Environment"; ValueType: expandsz; ValueName: "Path"; \
    ValueData: "{olddata};{app}"; Check: NeedsAddPath(ExpandConstant('{app}'))

[Code]
function NeedsAddPath(Param: string): boolean;
var
  OrigPath: string;
begin
  if not RegQueryStringValue(HKEY_CURRENT_USER, 'Environment', 'Path', OrigPath) then
  begin
    Result := True;
    exit;
  end;
  Result := Pos(';' + Uppercase(Param) + ';', ';' + Uppercase(OrigPath) + ';') = 0;
end;
