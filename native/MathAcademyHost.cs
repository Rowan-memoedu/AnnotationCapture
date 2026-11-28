using System;
using System.IO;
using System.IO.Pipes;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Threading.Tasks;

internal static class MathAcademyHost
{
    private const string Origin = "chrome-extension://gdejildelbenfhefjohighebigmnmame/";

    // Chrome's native messaging framing is carried unchanged over the local pipe.
    private static async Task Relay(Stream source, Stream destination)
    {
        byte[] buffer = new byte[8192];
        int read;
        while ((read = await source.ReadAsync(buffer, 0, buffer.Length)) > 0)
        {
            await destination.WriteAsync(buffer, 0, read);
            await destination.FlushAsync();
        }
    }

    private static int Main(string[] args)
    {
        if (args.Length == 0 || args[0] != Origin) return 1;
        string identity = (Environment.UserDomainName + "\\" + Environment.UserName + "|" +
            Path.GetFullPath(Assembly.GetExecutingAssembly().Location)).ToLowerInvariant();
        string hash;
        using (var sha = SHA256.Create())
            hash = BitConverter.ToString(sha.ComputeHash(Encoding.UTF8.GetBytes(identity))).Replace("-", "").Substring(0, 32).ToLowerInvariant();
        try
        {
            using (var pipe = new NamedPipeClientStream(".", "AnnotationCapture.MathAcademy." + hash, PipeDirection.InOut, PipeOptions.Asynchronous))
            {
                pipe.Connect(3000);
                var input = Task.Run(() => Relay(Console.OpenStandardInput(), pipe));
                var output = Task.Run(() => Relay(pipe, Console.OpenStandardOutput()));
                Task.WaitAny(input, output);
            }
            return 0;
        }
        catch (IOException) { return 1; }
        catch (TimeoutException) { return 1; }
    }
}
