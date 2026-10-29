/*
 * AIchat-graph Windows thin launcher.
 *
 * A small native entry (GUI subsystem, static CRT) that finds the program package
 * around itself, starts the packaged Node CLI hidden, shows native folder pickers
 * and reports failures. It contains no application logic: workspaces, services,
 * databases and updates stay in Node (app/dist/next/cli.js, app/dist/portable/update.js).
 *
 * Modes (see .local/tasks/portable-contract.md):
 *   (default)             node app/dist/next/cli.js open --interactive --text
 *   --choose-workspace    node app/dist/next/cli.js open --interactive --choose-workspace --text
 *   --stop                node app/dist/next/cli.js stop --interactive --text
 *   --update              pick target package dir + confirm, then
 *                         node app/dist/portable/update.js --source <self> --target <target>
 *   --pick-workspace      internal: show folder picker, print UTF-8 path, cancel=2
 *   --pick-installation   internal: same, for the package directory to update
 *   --open-url <url>      internal: open an already-confirmed local reader URL
 *
 * Build (MinGW-w64 x64):
 *   gcc -O2 -s -municode -mwindows -static -o AIchat-graph.exe launcher.c
 *       -lole32 -lshell32 -luser32
 */
#ifndef UNICODE
#define UNICODE
#endif
#ifndef _UNICODE
#define _UNICODE
#endif
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <shellapi.h>
#include <shlobj.h>
#include <objbase.h>
#include <stdio.h>
#include <wchar.h>
#include <stdarg.h>

#define APP_TITLE L"AIchat-graph"
#define PATH_CAP 32768
#define LOG_RELATIVE L".aichat\\logs\\entry.log"

typedef enum Mode {
  MODE_OPEN,
  MODE_CHOOSE_WORKSPACE,
  MODE_STOP,
  MODE_UPDATE,
  MODE_PICK_WORKSPACE,
  MODE_PICK_INSTALLATION,
  MODE_OPEN_URL,
  MODE_USAGE
} Mode;

static HINSTANCE g_instance;
static WCHAR g_root[PATH_CAP];
static WCHAR g_node[PATH_CAP];
static WCHAR g_cli[PATH_CAP];
static WCHAR g_update[PATH_CAP];
static WCHAR g_manifest[PATH_CAP];
static WCHAR g_log[PATH_CAP];
static BOOL g_internal = FALSE;

static void CopyString(WCHAR *out, size_t cap, const WCHAR *text) {
  if (cap == 0) return;
  wcsncpy(out, text, cap - 1);
  out[cap - 1] = L'\0';
}

static BOOL JoinPath(WCHAR *out, size_t cap, const WCHAR *base, const WCHAR *relative) {
  size_t baseLength = wcslen(base);
  size_t relativeLength = wcslen(relative);
  BOOL needsSeparator = baseLength > 0 && base[baseLength - 1] != L'\\' && base[baseLength - 1] != L'/';
  if (baseLength + (needsSeparator ? 1 : 0) + relativeLength + 1 > cap) return FALSE;
  CopyString(out, cap, base);
  if (needsSeparator) wcscat(out, L"\\");
  wcscat(out, relative);
  return TRUE;
}

static BOOL FileExists(const WCHAR *path) {
  DWORD attributes = GetFileAttributesW(path);
  return attributes != INVALID_FILE_ATTRIBUTES && (attributes & FILE_ATTRIBUTE_DIRECTORY) == 0;
}

static BOOL DirectoryExists(const WCHAR *path) {
  DWORD attributes = GetFileAttributesW(path);
  return attributes != INVALID_FILE_ATTRIBUTES && (attributes & FILE_ATTRIBUTE_DIRECTORY) != 0;
}

static BOOL EnsureDirectory(const WCHAR *path) {
  if (DirectoryExists(path)) return TRUE;
  if (CreateDirectoryW(path, NULL)) return TRUE;
  return GetLastError() == ERROR_ALREADY_EXISTS;
}

static void WriteUtf8(HANDLE handle, const WCHAR *text) {
  if (handle == NULL || handle == INVALID_HANDLE_VALUE || text == NULL) return;
  int bytes = WideCharToMultiByte(CP_UTF8, 0, text, -1, NULL, 0, NULL, NULL);
  if (bytes <= 0) return;
  char *buffer = (char *)HeapAlloc(GetProcessHeap(), 0, (SIZE_T)bytes);
  if (buffer == NULL) return;
  WideCharToMultiByte(CP_UTF8, 0, text, -1, buffer, bytes, NULL, NULL);
  DWORD written = 0;
  WriteFile(handle, buffer, (DWORD)(bytes - 1), &written, NULL);
  HeapFree(GetProcessHeap(), 0, buffer);
}

static void FormatMessageBuffer(WCHAR *out, size_t cap, const WCHAR *format, va_list args) {
  if (cap == 0) return;
  _vsnwprintf(out, cap - 1, format, args);
  out[cap - 1] = L'\0';
}

/** Internal modes report on stderr (they are started by Node); normal modes use a message box. */
static void ReportFailure(const WCHAR *format, ...) {
  WCHAR text[8192];
  va_list args;
  va_start(args, format);
  FormatMessageBuffer(text, 8192, format, args);
  va_end(args);
  if (g_internal) {
    WriteUtf8(GetStdHandle(STD_ERROR_HANDLE), text);
    WriteUtf8(GetStdHandle(STD_ERROR_HANDLE), L"\r\n");
  } else {
    MessageBoxW(NULL, text, APP_TITLE, MB_OK | MB_ICONERROR | MB_SETFOREGROUND | MB_TOPMOST);
  }
}

static void ReportInfo(const WCHAR *format, ...) {
  WCHAR text[8192];
  va_list args;
  va_start(args, format);
  FormatMessageBuffer(text, 8192, format, args);
  va_end(args);
  MessageBoxW(NULL, text, APP_TITLE, MB_OK | MB_ICONINFORMATION | MB_SETFOREGROUND | MB_TOPMOST);
}

static BOOL ConfirmQuestion(const WCHAR *format, ...) {
  WCHAR text[8192];
  va_list args;
  va_start(args, format);
  FormatMessageBuffer(text, 8192, format, args);
  va_end(args);
  return MessageBoxW(NULL, text, APP_TITLE, MB_YESNO | MB_ICONQUESTION | MB_SETFOREGROUND | MB_TOPMOST) == IDYES;
}

static BOOL GetSelfDirectory(void) {
  DWORD length = GetModuleFileNameW(NULL, g_root, PATH_CAP);
  if (length == 0 || length >= PATH_CAP) return FALSE;
  WCHAR *slash = wcsrchr(g_root, L'\\');
  if (slash == NULL) slash = wcsrchr(g_root, L'/');
  if (slash == NULL) return FALSE;
  *slash = L'\0';
  return g_root[0] != L'\0';
}

static BOOL LooksLikePortableManifest(const WCHAR *path) {
  HANDLE file = CreateFileW(path, GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                            NULL, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
  if (file == INVALID_HANDLE_VALUE) return FALSE;
  BYTE buffer[131072];
  DWORD read = 0;
  BOOL ok = ReadFile(file, buffer, sizeof(buffer) - 1, &read, NULL) != 0;
  CloseHandle(file);
  if (!ok || read == 0) return FALSE;
  buffer[read] = 0;
  int wideLength = MultiByteToWideChar(CP_UTF8, 0, (const char *)buffer, (int)read, NULL, 0);
  if (wideLength <= 0) return FALSE;
  WCHAR *text = (WCHAR *)HeapAlloc(GetProcessHeap(), 0, ((SIZE_T)wideLength + 1) * sizeof(WCHAR));
  if (text == NULL) return FALSE;
  MultiByteToWideChar(CP_UTF8, 0, (const char *)buffer, (int)read, text, wideLength);
  text[wideLength] = L'\0';
  BOOL valid = wcsstr(text, L"aichat-graph-portable") != NULL &&
               wcsstr(text, L"\"schemaVersion\"") != NULL &&
               wcsstr(text, L"win32-x64") != NULL;
  HeapFree(GetProcessHeap(), 0, text);
  return valid;
}

static void ResolvePackagePaths(void) {
  JoinPath(g_node, PATH_CAP, g_root, L"runtime\\node.exe");
  JoinPath(g_cli, PATH_CAP, g_root, L"app\\dist\\next\\cli.js");
  JoinPath(g_update, PATH_CAP, g_root, L"app\\dist\\portable\\update.js");
  JoinPath(g_manifest, PATH_CAP, g_root, L"distribution.json");
  JoinPath(g_log, PATH_CAP, g_root, LOG_RELATIVE);
}

static BOOL ValidatePackage(void) {
  if (!FileExists(g_node)) {
    ReportFailure(L"程序包不完整：缺少 runtime\\node.exe。\n\n请重新完整解压下载的 ZIP，不要把程序文件拆开复制。\n\n位置：%s", g_node);
    return FALSE;
  }
  if (!FileExists(g_cli)) {
    ReportFailure(L"程序包不完整：缺少 app\\dist\\next\\cli.js。\n\n请重新完整解压下载的 ZIP，不要把程序文件拆开复制。\n\n位置：%s", g_cli);
    return FALSE;
  }
  if (!FileExists(g_manifest) || !LooksLikePortableManifest(g_manifest)) {
    ReportFailure(L"程序包标识缺失或无效：distribution.json。\n\n请重新完整解压下载的 ZIP，并保持包根文件与 app\\、runtime\\ 在一起。\n\n位置：%s", g_manifest);
    return FALSE;
  }
  return TRUE;
}

static void AppendQuotedArgument(WCHAR *out, size_t cap, const WCHAR *argument) {
  size_t used = wcslen(out);
  if (used + 4 >= cap) return;
  out[used++] = L'"';
  const WCHAR *cursor = argument;
  size_t backslashes = 0;
  while (*cursor != L'\0' && used + 4 < cap) {
    if (*cursor == L'\\') {
      backslashes += 1;
      cursor += 1;
      continue;
    }
    if (*cursor == L'"') {
      // Windows quoting: 2*n+1 backslashes before a literal quote.
      for (size_t index = 0; index < backslashes * 2 + 1 && used + 2 < cap; index += 1) out[used++] = L'\\';
      if (used + 2 < cap) out[used++] = L'"';
      backslashes = 0;
      cursor += 1;
      continue;
    }
    // Normal characters keep the pending backslashes unchanged.
    for (size_t index = 0; index < backslashes && used + 2 < cap; index += 1) out[used++] = L'\\';
    backslashes = 0;
    if (used + 2 < cap) out[used++] = *cursor;
    cursor += 1;
  }
  // A trailing run of backslashes is doubled so it cannot escape the closing quote.
  for (size_t index = 0; index < backslashes * 2 && used + 2 < cap; index += 1) out[used++] = L'\\';
  if (used + 2 < cap) out[used++] = L'"';
  out[used] = L'\0';
}

static BOOL RunNode(const WCHAR *script, const WCHAR *const *arguments, int argumentCount, DWORD *exitCode) {
  WCHAR commandLine[PATH_CAP * 2];
  commandLine[0] = L'\0';
  AppendQuotedArgument(commandLine, PATH_CAP * 2, g_node);
  wcscat(commandLine, L" ");
  AppendQuotedArgument(commandLine, PATH_CAP * 2, script);
  for (int index = 0; index < argumentCount; index += 1) {
    wcscat(commandLine, L" ");
    AppendQuotedArgument(commandLine, PATH_CAP * 2, arguments[index]);
  }

  WCHAR runtimeStateDirectory[PATH_CAP];
  WCHAR logsDirectory[PATH_CAP];
  JoinPath(runtimeStateDirectory, PATH_CAP, g_root, L".aichat");
  EnsureDirectory(runtimeStateDirectory);
  JoinPath(logsDirectory, PATH_CAP, g_root, L".aichat\\logs");
  EnsureDirectory(logsDirectory);

  SECURITY_ATTRIBUTES security;
  security.nLength = sizeof(security);
  security.lpSecurityDescriptor = NULL;
  security.bInheritHandle = TRUE;
  HANDLE nullHandle = CreateFileW(L"NUL", GENERIC_READ | GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE,
                                  &security, OPEN_EXISTING, 0, NULL);
  if (nullHandle == INVALID_HANDLE_VALUE) nullHandle = NULL;
  HANDLE logHandle = CreateFileW(g_log, GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE, &security,
                                CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
  if (logHandle == INVALID_HANDLE_VALUE) logHandle = NULL;
  if (logHandle != NULL) {
    WCHAR header[512];
    SYSTEMTIME now;
    GetLocalTime(&now);
    _snwprintf(header, 511, L"AIchat-graph launcher %04d-%02d-%02d %02d:%02d:%02d\r\n",
               now.wYear, now.wMonth, now.wDay, now.wHour, now.wMinute, now.wSecond);
    header[511] = L'\0';
    WriteUtf8(logHandle, header);
  }

  STARTUPINFOW startup;
  ZeroMemory(&startup, sizeof(startup));
  startup.cb = sizeof(startup);
  startup.dwFlags = STARTF_USESTDHANDLES;
  startup.hStdInput = nullHandle != NULL ? nullHandle : GetStdHandle(STD_INPUT_HANDLE);
  startup.hStdOutput = logHandle != NULL ? logHandle : GetStdHandle(STD_OUTPUT_HANDLE);
  startup.hStdError = logHandle != NULL ? logHandle : GetStdHandle(STD_ERROR_HANDLE);

  PROCESS_INFORMATION process;
  ZeroMemory(&process, sizeof(process));
  BOOL created = CreateProcessW(NULL, commandLine, NULL, NULL, TRUE,
                                CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT,
                                NULL, g_root, &startup, &process);
  if (nullHandle != NULL) CloseHandle(nullHandle);
  if (!created) {
    DWORD error = GetLastError();
    if (logHandle != NULL) {
      WCHAR line[256];
      _snwprintf(line, 255, L"CreateProcessW failed: %lu\r\n", (unsigned long)error);
      line[255] = L'\0';
      WriteUtf8(logHandle, line);
      CloseHandle(logHandle);
    }
    ReportFailure(L"无法启动程序运行时（错误 %lu）。\n\n请确认程序包完整、目录可读，然后重试。", (unsigned long)error);
    return FALSE;
  }
  if (logHandle != NULL) CloseHandle(logHandle);
  WaitForSingleObject(process.hProcess, INFINITE);
  DWORD code = 1;
  GetExitCodeProcess(process.hProcess, &code);
  CloseHandle(process.hThread);
  CloseHandle(process.hProcess);
  *exitCode = code;
  return TRUE;
}

/** Show the Windows folder picker. Returns 1 selected, 0 cancelled, -1 error. */
static int PickFolder(const WCHAR *title, WCHAR *out, size_t cap) {
  HRESULT initialized = CoInitializeEx(NULL, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE);
  BOOL shouldUninitialize = SUCCEEDED(initialized);
  BROWSEINFOW browse;
  ZeroMemory(&browse, sizeof(browse));
  browse.hwndOwner = NULL;
  browse.lpszTitle = title;
  browse.ulFlags = BIF_RETURNONLYFSDIRS | BIF_NEWDIALOGSTYLE | BIF_EDITBOX;
  PIDLIST_ABSOLUTE item = SHBrowseForFolderW(&browse);
  int result = -1;
  if (item == NULL) {
    result = 0;
  } else {
    WCHAR path[MAX_PATH];
    path[0] = L'\0';
    if (SHGetPathFromIDListW(item, path) && path[0] != L'\0') {
      CopyString(out, cap, path);
      result = 1;
    }
    CoTaskMemFree(item);
  }
  if (shouldUninitialize) CoUninitialize();
  return result;
}

static BOOL IsLocalReaderUrl(const WCHAR *url) {
  const WCHAR *prefixes[] = {
    L"http://127.0.0.1:",
    L"https://127.0.0.1:",
    L"http://localhost:",
    L"https://localhost:",
  };
  for (size_t index = 0; index < sizeof(prefixes) / sizeof(prefixes[0]); index += 1) {
    size_t length = wcslen(prefixes[index]);
    if (_wcsnicmp(url, prefixes[index], length) == 0) return TRUE;
  }
  return FALSE;
}

static int RunOpenOrStop(Mode mode) {
  DWORD exitCode = 1;
  const WCHAR *openArguments[] = { L"open", L"--interactive", L"--text" };
  const WCHAR *chooseArguments[] = { L"open", L"--interactive", L"--choose-workspace", L"--text" };
  const WCHAR *stopArguments[] = { L"stop", L"--interactive", L"--text" };
  BOOL started;
  if (mode == MODE_OPEN) started = RunNode(g_cli, openArguments, 3, &exitCode);
  else if (mode == MODE_CHOOSE_WORKSPACE) started = RunNode(g_cli, chooseArguments, 4, &exitCode);
  else started = RunNode(g_cli, stopArguments, 3, &exitCode);
  if (!started) return 1;
  if (exitCode == 0) return 0;
  if (exitCode == 2) return 0;
  ReportFailure(L"打开或停止讨论库失败（退出码 %lu）。\n\n可以查看日志了解具体原因：\n%s\n\n也可以从命令行运行 aichat.cmd --help 检查程序状态。",
                (unsigned long)exitCode, g_log);
  return 1;
}

static int RunUpdate(void) {
  if (!FileExists(g_update)) {
    ReportFailure(L"程序包不完整：缺少 app\\dist\\portable\\update.js，无法更新其他程序。\n\n请重新完整解压新包后重试。");
    return 1;
  }
  WCHAR target[PATH_CAP];
  target[0] = L'\0';
  int picked = PickFolder(L"选择要更新的 AIchat-graph 程序目录（需包含 distribution.json）", target, PATH_CAP);
  if (picked == 0) return 2;
  if (picked < 0) {
    ReportFailure(L"无法打开目录选择器。\n\n可以改为手动运行新包里的“更新已有程序.cmd”。");
    return 1;
  }
  WCHAR targetManifest[PATH_CAP];
  WCHAR targetExe[PATH_CAP];
  JoinPath(targetManifest, PATH_CAP, target, L"distribution.json");
  JoinPath(targetExe, PATH_CAP, target, L"AIchat-graph.exe");
  if (!FileExists(targetManifest) || !LooksLikePortableManifest(targetManifest) || !FileExists(targetExe)) {
    ReportFailure(L"所选目录不是完整的 AIchat-graph 程序目录：\n%s\n\n请选择包含 AIchat-graph.exe 与 distribution.json 的旧程序目录（不要选讨论库目录）。",
                  target);
    return 1;
  }
  if (!ConfirmQuestion(L"将把当前新包的程序文件替换到：\n\n%s\n\n目标目录的 .aichat 设置与所有外部讨论库都会保留。\n请先退出旧程序正在服务的讨论库并关闭程序窗口。\n\n继续更新？",
                       target)) {
    return 2;
  }
  const WCHAR *arguments[] = { L"--source", g_root, L"--target", target };
  DWORD exitCode = 1;
  if (!RunNode(g_update, arguments, 4, &exitCode)) return 1;
  if (exitCode != 0) {
    ReportFailure(L"更新失败（退出码 %lu）。\n\n具体原因见日志：\n%s\n\n请确认旧程序已退出后，从新包重新运行更新入口。",
                  (unsigned long)exitCode, g_log);
    return 1;
  }
  ReportInfo(L"更新完成。\n\n程序位置：%s\n\n设置与讨论库均已保留。请从原位置打开新程序。", target);
  return 0;
}

static int RunPick(Mode mode) {
  WCHAR selected[PATH_CAP];
  selected[0] = L'\0';
  const WCHAR *title = mode == MODE_PICK_WORKSPACE
      ? L"选择讨论库目录（含 graph.sqlite 的已有目录，或新建一个空文件夹）"
      : L"选择要更新的 AIchat-graph 程序目录（含 distribution.json）";
  int picked = PickFolder(title, selected, PATH_CAP);
  if (picked == 0) return 2;
  if (picked < 0) {
    ReportFailure(L"无法打开目录选择器。");
    return 1;
  }
  WCHAR output[PATH_CAP + 2];
  CopyString(output, PATH_CAP, selected);
  wcscat(output, L"\r\n");
  WriteUtf8(GetStdHandle(STD_OUTPUT_HANDLE), output);
  return 0;
}

static int RunOpenUrl(const WCHAR *url) {
  if (url == NULL || !IsLocalReaderUrl(url)) {
    ReportFailure(L"只能打开本机阅读地址。");
    return 1;
  }
  HINSTANCE result = ShellExecuteW(NULL, L"open", url, NULL, NULL, SW_SHOWNORMAL);
  if ((INT_PTR)result <= 32) {
    ReportFailure(L"无法打开默认浏览器。请手动打开：\n%s", url);
    return 1;
  }
  return 0;
}

static void ShowUsage(void) {
  const WCHAR *text =
      L"AIchat-graph 程序入口\n\n"
      L"双击直接打开上次的讨论库；首次使用时选择讨论库目录。\n\n"
      L"可选参数：\n"
      L"  --choose-workspace   重新选择讨论库\n"
      L"  --stop               退出本库后台服务\n"
      L"  --update             用本包更新另一个 AIchat-graph 程序目录\n"
      L"  --help               显示本说明\n\n"
      L"程序文件不完整时请重新完整解压下载的 ZIP。";
  if (g_internal) {
    WriteUtf8(GetStdHandle(STD_ERROR_HANDLE), text);
    WriteUtf8(GetStdHandle(STD_ERROR_HANDLE), L"\r\n");
  } else {
    MessageBoxW(NULL, text, APP_TITLE, MB_OK | MB_ICONINFORMATION | MB_SETFOREGROUND | MB_TOPMOST);
  }
}

int wWinMain(HINSTANCE instance, HINSTANCE previous, PWSTR commandLine, int showCommand) {
  (void)previous;
  (void)commandLine;
  (void)showCommand;
  g_instance = instance;

  int argumentCount = 0;
  WCHAR **arguments = CommandLineToArgvW(GetCommandLineW(), &argumentCount);
  Mode mode = MODE_OPEN;
  const WCHAR *openUrl = NULL;
  if (argumentCount >= 2) {
    if (wcscmp(arguments[1], L"--choose-workspace") == 0) mode = MODE_CHOOSE_WORKSPACE;
    else if (wcscmp(arguments[1], L"--stop") == 0) mode = MODE_STOP;
    else if (wcscmp(arguments[1], L"--update") == 0) mode = MODE_UPDATE;
    else if (wcscmp(arguments[1], L"--pick-workspace") == 0) mode = MODE_PICK_WORKSPACE;
    else if (wcscmp(arguments[1], L"--pick-installation") == 0) mode = MODE_PICK_INSTALLATION;
    else if (wcscmp(arguments[1], L"--open-url") == 0 && argumentCount == 3) {
      mode = MODE_OPEN_URL;
      openUrl = arguments[2];
    } else if (wcscmp(arguments[1], L"--help") == 0 || wcscmp(arguments[1], L"-h") == 0) {
      mode = MODE_USAGE;
    } else {
      g_internal = TRUE;
      ReportFailure(L"无法识别的参数：%s", arguments[1]);
      ShowUsage();
      LocalFree(arguments);
      return 1;
    }
  }
  g_internal = mode == MODE_PICK_WORKSPACE || mode == MODE_PICK_INSTALLATION || mode == MODE_OPEN_URL;

  if (!GetSelfDirectory()) {
    ReportFailure(L"无法确定程序所在目录。请从完整解压后的程序目录中运行 AIchat-graph.exe。");
    LocalFree(arguments);
    return 1;
  }
  ResolvePackagePaths();
  if (mode != MODE_USAGE && !ValidatePackage()) {
    LocalFree(arguments);
    return 1;
  }

  int result = 1;
  switch (mode) {
    case MODE_OPEN:
    case MODE_CHOOSE_WORKSPACE:
    case MODE_STOP:
      result = RunOpenOrStop(mode);
      break;
    case MODE_UPDATE:
      result = RunUpdate();
      break;
    case MODE_PICK_WORKSPACE:
    case MODE_PICK_INSTALLATION:
      result = RunPick(mode);
      break;
    case MODE_OPEN_URL:
      result = RunOpenUrl(openUrl);
      break;
    case MODE_USAGE:
      ShowUsage();
      result = 0;
      break;
  }
  LocalFree(arguments);
  return result;
}
