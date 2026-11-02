using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.IO.Compression;
using System.Runtime.InteropServices;

internal static class ScreenFrame
{
    [DllImport("user32.dll")]
    private static extern bool SetProcessDpiAwarenessContext(IntPtr value);

    // FocusToolWin, ScreenshotService.CaptureScreenBitmap (MIT, see THIRD_PARTY_NOTICES.md).
    private static Bitmap CaptureScreenBitmap(Rectangle bounds)
    {
        var bitmap = new Bitmap(bounds.Width, bounds.Height, PixelFormat.Format32bppArgb);
        try
        {
            using (var graphics = Graphics.FromImage(bitmap))
                graphics.CopyFromScreen(bounds.Left, bounds.Top, 0, 0, bounds.Size, CopyPixelOperation.SourceCopy);
            return bitmap;
        }
        catch
        {
            bitmap.Dispose();
            throw;
        }
    }

    private static unsafe void WriteFrame(Rectangle bounds, Stream output)
    {
        using (var bitmap = CaptureScreenBitmap(bounds))
        {
            var data = bitmap.LockBits(new Rectangle(Point.Empty, bounds.Size), ImageLockMode.ReadOnly, bitmap.PixelFormat);
            try
            {
                var row = new byte[bounds.Width * 4];
                fixed (byte* target = row)
                {
                    for (int y = 0; y < bounds.Height; y++)
                    {
                        var pixels = (byte*)data.Scan0 + y * data.Stride;
                        for (int x = 0; x < row.Length; x += 4)
                        {
                            target[x] = pixels[x + 2];
                            target[x + 1] = pixels[x + 1];
                            target[x + 2] = pixels[x];
                            target[x + 3] = 255;
                        }
                        output.Write(row, 0, row.Length);
                    }
                }
            }
            finally { bitmap.UnlockBits(data); }
        }
    }

    private static int Main(string[] args)
    {
        try
        {
            SetProcessDpiAwarenessContext(new IntPtr(-4)); // Per-monitor v2, physical desktop coordinates.
            if (args.Length == 0)
            {
                var request = Console.ReadLine();
                if (request == null) return 0;
                args = request.Split(' ');
            }
            var bounds = new Rectangle(int.Parse(args[0]), int.Parse(args[1]), int.Parse(args[2]), int.Parse(args[3]));
            using (var stream = Console.OpenStandardOutput())
            using (var output = new DeflateStream(stream, CompressionLevel.Fastest))
                WriteFrame(bounds, output);
            return 0;
        }
        catch (Exception e) { Console.Error.WriteLine(e.Message); return 1; }
    }
}
