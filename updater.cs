using System;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;

class Program
{
    static string Arg(string[] args, string name)
    {
        for (int i = 0; i + 1 < args.Length; i++) if (args[i] == name) return args[i + 1];
        return "";
    }

    static void Main(string[] args)
    {
        string packagePath = Arg(args, "--package");
        string appDir = Arg(args, "--app-dir");
        string launcher = Arg(args, "--launcher");
        string parentPid = Arg(args, "--pid");
        string backup = appDir + ".update-backup";
        string staging = appDir + ".update-staging";
        string log = Path.Combine(Path.GetDirectoryName(appDir) ?? ".", "updater.log");
        try
        {
            if (!File.Exists(packagePath) || !Directory.Exists(appDir)) throw new Exception("Update package or application directory is missing.");
            int pid;
            if (Int32.TryParse(parentPid, out pid))
            {
                try { Process.GetProcessById(pid).WaitForExit(30000); } catch (ArgumentException) { }
            }
            if (Directory.Exists(staging)) Directory.Delete(staging, true);
            if (Directory.Exists(backup)) Directory.Delete(backup, true);
            Directory.CreateDirectory(staging);
            ZipFile.ExtractToDirectory(packagePath, staging);
            string stagingApp = Path.Combine(staging, "resources", "app");
            if (!Directory.Exists(stagingApp) || !File.Exists(Path.Combine(stagingApp, "package.json")) || !File.Exists(Path.Combine(stagingApp, "dist", "index.html"))) throw new Exception("The update package is invalid.");
            Directory.Move(appDir, backup);
            Directory.Move(stagingApp, appDir);
            Directory.Delete(staging, true);
            File.Delete(packagePath);
            Process process = Process.Start(new ProcessStartInfo(launcher) { UseShellExecute = true, WorkingDirectory = Path.GetDirectoryName(launcher) });
            if (process != null && process.WaitForExit(10000))
            {
                if (Directory.Exists(appDir)) Directory.Delete(appDir, true);
                if (Directory.Exists(backup)) Directory.Move(backup, appDir);
                Process.Start(new ProcessStartInfo(launcher) { UseShellExecute = true, WorkingDirectory = Path.GetDirectoryName(launcher) });
                File.WriteAllText(log, "Updated application exited during health check; restored the previous version.");
            }
            else if (Directory.Exists(backup)) Directory.Delete(backup, true);
        }
        catch (Exception error)
        {
            try
            {
                if (Directory.Exists(appDir)) Directory.Delete(appDir, true);
                if (Directory.Exists(backup)) Directory.Move(backup, appDir);
                if (Directory.Exists(staging)) Directory.Delete(staging, true);
                File.WriteAllText(log, error.ToString());
                if (File.Exists(launcher)) Process.Start(new ProcessStartInfo(launcher) { UseShellExecute = true, WorkingDirectory = Path.GetDirectoryName(launcher) });
            }
            catch (Exception recoveryError) { File.WriteAllText(log, error + Environment.NewLine + recoveryError); }
        }
    }
}
