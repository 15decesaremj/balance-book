#include <windows.h>
#include <shellapi.h>
#include <shlobj.h>

#include <string>
#include <vector>

namespace {

constexpr wchar_t kProductName[] = L"Balance Book";
constexpr wchar_t kInstallerIdentity[] = L"balance_book_mvp";
constexpr wchar_t kUpdaterName[] = L"Update.exe";

struct Options {
  bool silent = false;
  bool show_help = false;
};

Options ParseOptions() {
  Options options;
  int argument_count = 0;
  wchar_t** arguments = CommandLineToArgvW(GetCommandLineW(), &argument_count);
  if (arguments == nullptr) return options;

  for (int index = 1; index < argument_count; ++index) {
    const std::wstring argument(arguments[index]);
    if (argument == L"--silent" || argument == L"/silent" || argument == L"-s") {
      options.silent = true;
    } else if (argument == L"--help" || argument == L"/?") {
      options.show_help = true;
    }
  }
  LocalFree(arguments);
  return options;
}

std::wstring WindowsErrorMessage(const DWORD error_code) {
  wchar_t* buffer = nullptr;
  const DWORD length = FormatMessageW(
      FORMAT_MESSAGE_ALLOCATE_BUFFER | FORMAT_MESSAGE_FROM_SYSTEM |
          FORMAT_MESSAGE_IGNORE_INSERTS,
      nullptr, error_code, MAKELANGID(LANG_NEUTRAL, SUBLANG_DEFAULT),
      reinterpret_cast<wchar_t*>(&buffer), 0, nullptr);
  if (length == 0 || buffer == nullptr) {
    return L"Windows error " + std::to_wstring(error_code);
  }
  std::wstring message(buffer, length);
  LocalFree(buffer);
  while (!message.empty() &&
         (message.back() == L'\r' || message.back() == L'\n' || message.back() == L' ')) {
    message.pop_back();
  }
  return message;
}

void ShowMessage(const Options& options, const std::wstring& message, const UINT flags) {
  if (!options.silent) MessageBoxW(nullptr, message.c_str(), kProductName, flags);
}

bool IsRegularFile(const std::wstring& path) {
  const DWORD attributes = GetFileAttributesW(path.c_str());
  return attributes != INVALID_FILE_ATTRIBUTES &&
         (attributes & FILE_ATTRIBUTE_DIRECTORY) == 0;
}

std::wstring ResolveUpdaterPath() {
  PWSTR local_app_data = nullptr;
  const HRESULT result =
      SHGetKnownFolderPath(FOLDERID_LocalAppData, KF_FLAG_DEFAULT, nullptr, &local_app_data);
  if (FAILED(result) || local_app_data == nullptr) return {};

  std::wstring path(local_app_data);
  CoTaskMemFree(local_app_data);
  path.append(L"\\").append(kInstallerIdentity).append(L"\\").append(kUpdaterName);
  return path;
}

std::wstring ParentDirectory(const std::wstring& path) {
  const std::wstring::size_type separator = path.find_last_of(L"\\/");
  return separator == std::wstring::npos ? std::wstring() : path.substr(0, separator);
}

int RunSquirrelUninstaller(const Options& options, const std::wstring& updater_path) {
  std::wstring command_line = L"\"" + updater_path + L"\" --uninstall";
  if (options.silent) command_line.append(L" -s");
  std::vector<wchar_t> mutable_command(command_line.begin(), command_line.end());
  mutable_command.push_back(L'\0');

  STARTUPINFOW startup_info{};
  startup_info.cb = sizeof(startup_info);
  PROCESS_INFORMATION process_info{};
  const std::wstring working_directory = ParentDirectory(updater_path);

  if (!CreateProcessW(updater_path.c_str(), mutable_command.data(), nullptr, nullptr, FALSE,
                      CREATE_UNICODE_ENVIRONMENT, nullptr, working_directory.c_str(),
                      &startup_info, &process_info)) {
    const DWORD error_code = GetLastError();
    ShowMessage(options,
                L"Balance Book could not start its installed uninstaller.\n\n" +
                    WindowsErrorMessage(error_code),
                MB_OK | MB_ICONERROR);
    return 3;
  }

  CloseHandle(process_info.hThread);
  const DWORD wait_result = WaitForSingleObject(process_info.hProcess, INFINITE);
  if (wait_result != WAIT_OBJECT_0) {
    const DWORD error_code = GetLastError();
    CloseHandle(process_info.hProcess);
    ShowMessage(options,
                L"Windows could not confirm that Balance Book finished uninstalling.\n\n" +
                    WindowsErrorMessage(error_code),
                MB_OK | MB_ICONERROR);
    return 4;
  }

  DWORD exit_code = 1;
  const BOOL read_exit_code = GetExitCodeProcess(process_info.hProcess, &exit_code);
  CloseHandle(process_info.hProcess);
  if (!read_exit_code) {
    ShowMessage(options, L"Windows could not read the Balance Book uninstaller result.",
                MB_OK | MB_ICONERROR);
    return 5;
  }
  if (exit_code != 0) {
    ShowMessage(options,
                L"Balance Book did not uninstall successfully. The installed uninstaller returned " +
                    std::to_wstring(exit_code) + L".",
                MB_OK | MB_ICONERROR);
    return static_cast<int>(exit_code > 255 ? 6 : exit_code);
  }

  ShowMessage(options,
              L"Balance Book has been uninstalled.\n\nYour local profiles, password, and financial "
              L"data were kept so a later reinstall can use them.",
              MB_OK | MB_ICONINFORMATION);
  return 0;
}

}  // namespace

int WINAPI wWinMain(HINSTANCE, HINSTANCE, PWSTR, int) {
  const Options options = ParseOptions();
  if (options.show_help) {
    ShowMessage(options,
                L"Uninstalls Balance Book for the current Windows user.\n\n"
                L"Options:\n  --silent    Run without confirmation or result dialogs.",
                MB_OK | MB_ICONINFORMATION);
    return 0;
  }

  const std::wstring updater_path = ResolveUpdaterPath();
  if (updater_path.empty()) {
    ShowMessage(options, L"Windows could not locate the current user's local application folder.",
                MB_OK | MB_ICONERROR);
    return 2;
  }
  if (!IsRegularFile(updater_path)) {
    ShowMessage(options,
                L"Balance Book is not installed for this Windows user. No files were changed.",
                MB_OK | MB_ICONINFORMATION);
    return 2;
  }

  if (!options.silent) {
    const int answer = MessageBoxW(
        nullptr,
        L"Uninstall Balance Book?\n\nThe application will be removed, but your local profiles, "
        L"password, and financial data will remain available for a later reinstall.",
        kProductName, MB_YESNO | MB_ICONQUESTION | MB_DEFBUTTON2);
    if (answer != IDYES) return 0;
  }

  return RunSquirrelUninstaller(options, updater_path);
}
