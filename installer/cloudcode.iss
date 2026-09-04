#define AppName "cloudcode"
#define AppVersion "0.1.16"

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
UsePreviousAppDir=yes
CloseApplications=yes

[Files]
Source: "..\release\cloudcode-win-x64.exe"; DestDir: "{app}"; DestName: "cloudcode.exe"; Flags: ignoreversion

[Registry]
; Append install dir to the user PATH if not already present.
Root: HKCU; Subkey: "Environment"; ValueType: expandsz; ValueName: "Path"; \
    ValueData: "{olddata};{app}"; Check: NeedsAddPath(ExpandConstant('{app}'))

[Code]
{ Uninstall key name for the AppId above. The double braces in AppId }
{ render as a single brace pair, so the key uses single braces here. }
const
  OldUninstallKey = 'Software\Microsoft\Windows\CurrentVersion\Uninstall\{B7E4C1D2-5A3F-4E8B-9C6D-0F1A2B3C4D5E}_is1';

{ Prefer the quiet uninstall command when present, otherwise fall back to }
{ the regular uninstall string. Checks both 64-bit and 32-bit registry }
{ views under HKLM and HKCU because the previous install may have used }
{ either scope (lowest-privilege install lands in HKCU). }
function GetOldUninstallString(): string;
var
  Value: string;
begin
  Result := '';
  if RegQueryStringValue(HKLM64, OldUninstallKey, 'QuietUninstallString', Value) then begin Result := Value; exit; end;
  if RegQueryStringValue(HKCU64, OldUninstallKey, 'QuietUninstallString', Value) then begin Result := Value; exit; end;
  if RegQueryStringValue(HKLM64, OldUninstallKey, 'UninstallString', Value) then begin Result := Value; exit; end;
  if RegQueryStringValue(HKCU64, OldUninstallKey, 'UninstallString', Value) then begin Result := Value; exit; end;
  if RegQueryStringValue(HKLM, OldUninstallKey, 'QuietUninstallString', Value) then begin Result := Value; exit; end;
  if RegQueryStringValue(HKCU, OldUninstallKey, 'QuietUninstallString', Value) then begin Result := Value; exit; end;
  if RegQueryStringValue(HKLM, OldUninstallKey, 'UninstallString', Value) then begin Result := Value; exit; end;
  if RegQueryStringValue(HKCU, OldUninstallKey, 'UninstallString', Value) then begin Result := Value; exit; end;
end;

{ Silently remove a previous installation before installing the new one, }
{ so stale files from the old version never survive an upgrade. Failures }
{ are ignored on purpose: the fresh install still proceeds. }
function InitializeSetup(): Boolean;
var
  UninstallString: string;
  ResultCode: Integer;
begin
  Result := True;
  UninstallString := GetOldUninstallString();
  if UninstallString <> '' then
  begin
    Exec(RemoveQuotes(UninstallString), '/SILENT /NORESTART /SUPPRESSMSGBOXES', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  end;
end;

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
