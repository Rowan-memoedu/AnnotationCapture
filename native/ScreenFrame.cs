using System;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;

internal static class ScreenFrame
{
    [DllImport("user32.dll")]
    private static extern bool SetProcessDpiAwarenessContext(IntPtr value);

    [StructLayout(LayoutKind.Sequential)]
    private struct BitmapInfo
    {
        public uint Size;
        public int Width, Height;
        public ushort Planes, Bits;
        public uint Compression, ImageSize;
        public int XResolution, YResolution;
        public uint ColorsUsed, ImportantColors;
    }

    [DllImport("user32.dll")] private static extern IntPtr GetDC(IntPtr window);
    [DllImport("user32.dll")] private static extern int ReleaseDC(IntPtr window, IntPtr dc);
    [DllImport("gdi32.dll")] private static extern IntPtr CreateCompatibleDC(IntPtr dc);
    [DllImport("gdi32.dll")] private static extern bool DeleteDC(IntPtr dc);
    [DllImport("gdi32.dll")] private static extern IntPtr CreateDIBSection(
        IntPtr dc, ref BitmapInfo info, uint usage, out IntPtr bits, IntPtr section, uint offset);
    [DllImport("gdi32.dll")] private static extern IntPtr SelectObject(IntPtr dc, IntPtr value);
    [DllImport("gdi32.dll")] private static extern bool DeleteObject(IntPtr value);
    [DllImport("gdi32.dll")] private static extern bool BitBlt(
        IntPtr target, int x, int y, int width, int height, IntPtr source, int left, int top, uint operation);
    [DllImport("gdi32.dll")] private static extern bool GdiFlush();

    private static unsafe void WriteFrame(Rectangle bounds, Stream output, byte[] frame)
    {
        var screen = GetDC(IntPtr.Zero);
        if (screen == IntPtr.Zero) throw new IOException("Cannot open the screen");
        var target = IntPtr.Zero;
        var bitmap = IntPtr.Zero;
        var previous = IntPtr.Zero;
        try
        {
            target = CreateCompatibleDC(screen);
            var info = new BitmapInfo {
                Size = (uint)Marshal.SizeOf(typeof(BitmapInfo)),
                Width = bounds.Width,
                Height = -bounds.Height, // Top-down rows match ImageData.
                Planes = 1,
                Bits = 32,
            };
            IntPtr bits;
            bitmap = CreateDIBSection(screen, ref info, 0, out bits, IntPtr.Zero, 0);
            if (target == IntPtr.Zero || bitmap == IntPtr.Zero || bits == IntPtr.Zero)
                throw new IOException("Cannot allocate the screen frame");
            previous = SelectObject(target, bitmap);
            const uint SourceCopy = 0x00cc0020;
            if (previous == IntPtr.Zero || previous == new IntPtr(-1)
                || !BitBlt(target, 0, 0, bounds.Width, bounds.Height, screen, bounds.Left, bounds.Top, SourceCopy)
                || !GdiFlush())
                throw new IOException("Cannot read the screen frame");
            fixed (byte* pixels = frame)
            {
                var source = (uint*)bits;
                var rgba = (uint*)pixels;
                int pixelCount = frame.Length / 4;
                for (int i = 0; i < pixelCount; i++)
                {
                    uint bgra = source[i];
                    rgba[i] = 0xff000000 | ((bgra & 0x0000ff) << 16)
                        | (bgra & 0x00ff00) | ((bgra & 0xff0000) >> 16);
                }
            }
        }
        finally
        {
            if (previous != IntPtr.Zero && previous != new IntPtr(-1)) SelectObject(target, previous);
            if (bitmap != IntPtr.Zero) DeleteObject(bitmap);
            if (target != IntPtr.Zero) DeleteDC(target);
            ReleaseDC(IntPtr.Zero, screen);
        }
        output.Write(frame, 0, frame.Length);
        output.Flush();
    }

    private static int Main()
    {
        try
        {
            SetProcessDpiAwarenessContext(new IntPtr(-4)); // Per-monitor v2, physical desktop coordinates.
            using (var stream = Console.OpenStandardOutput())
            {
                var frame = new byte[0];
                string request;
                while ((request = Console.ReadLine()) != null)
                {
                    var args = request.Split(' ');
                    var bounds = new Rectangle(int.Parse(args[0]), int.Parse(args[1]), int.Parse(args[2]), int.Parse(args[3]));
                    int size = checked(bounds.Width * bounds.Height * 4);
                    if (frame.Length != size) frame = new byte[size];
                    WriteFrame(bounds, stream, frame);
                }
            }
            return 0;
        }
        catch (Exception e) { Console.Error.WriteLine(e.Message); return 1; }
    }
}
