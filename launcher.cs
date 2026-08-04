using System;
using System.Diagnostics;
using System.IO;

class Program
{
    static void Main()
    {
        string exeDir = AppDomain.CurrentDomain.BaseDirectory;
        string logPath = Path.Combine(exeDir, "launcher.log");
        string runtimeDir = exeDir;
        string electronPath = Path.Combine(runtimeDir, "electron.exe");
        string appPath = Path.Combine(runtimeDir, "resources", "app");

        try
        {
            if (File.Exists(logPath))
            {
                File.Delete(logPath);
            }

            if (!File.Exists(electronPath))
            {
                runtimeDir = Path.Combine(exeDir, "dist-portable");
                electronPath = Path.Combine(runtimeDir, "electron.exe");
                appPath = Path.Combine(runtimeDir, "resources", "app");
            }

            if (!File.Exists(electronPath))
            {
                File.WriteAllText(logPath, "electron.exe not found at: " + electronPath);
                return;
            }

            if (!Directory.Exists(appPath))
            {
                File.WriteAllText(logPath, "app directory not found at: " + appPath);
                return;
            }

            ProcessStartInfo psi = new ProcessStartInfo(electronPath, "\"" + appPath + "\"");
            psi.UseShellExecute = false;
            psi.WorkingDirectory = runtimeDir;

            using (Process proc = Process.Start(psi))
            {
                if (proc != null) proc.WaitForExit();
            }
        }
        catch (Exception ex)
        {
            File.WriteAllText(logPath, ex.ToString());
        }
    }
}
