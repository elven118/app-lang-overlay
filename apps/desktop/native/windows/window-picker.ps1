param([int]$ExcludedProcessId = 0, [switch]$Once)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

# Window metadata only. Electron owns capture and source authorization.
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class OverlayWindowMetadata {
    public delegate bool EnumProc(IntPtr window, IntPtr parameter);
    [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
    public class Bounds { public int x, y, width, height; }
    public class Window { public long id; public string name; public Bounds bounds; }
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc callback, IntPtr parameter);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr window);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr window, StringBuilder text, int count);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr window, out Rect rect);
    [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
    [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr window, int attribute, out int value, int size);
    [DllImport("dwmapi.dll", EntryPoint="DwmGetWindowAttribute")] static extern int DwmGetWindowRect(IntPtr window, int attribute, out Rect value, int size);

    public static Window[] Read(int excludedProcess) {
        // Per-monitor awareness keeps native rectangles in physical pixels.
        IntPtr previous = SetThreadDpiAwarenessContext(new IntPtr(-4));
        try {
            var windows = new List<Window>();
            EnumWindows(delegate(IntPtr window, IntPtr unused) {
                uint owner;
                GetWindowThreadProcessId(window, out owner);
                if (owner == excludedProcess || !IsWindowVisible(window) || IsIconic(window)) return true;
                int cloaked;
                if (DwmGetWindowAttribute(window, 14, out cloaked, 4) == 0 && cloaked != 0) return true;
                var title = new StringBuilder(1024);
                if (GetWindowText(window, title, title.Capacity) == 0) return true;
                Rect rect;
                if (DwmGetWindowRect(window, 9, out rect, Marshal.SizeOf(typeof(Rect))) != 0 && !GetWindowRect(window, out rect)) return true;
                if (rect.Right - rect.Left <= 1 || rect.Bottom - rect.Top <= 1) return true;
                windows.Add(new Window { id = window.ToInt64(), name = title.ToString(), bounds = new Bounds {
                    x = rect.Left, y = rect.Top, width = rect.Right - rect.Left, height = rect.Bottom - rect.Top } });
                return true;
            }, IntPtr.Zero);
            return windows.ToArray();
        } finally {
            if (previous != IntPtr.Zero) SetThreadDpiAwarenessContext(previous);
        }
    }
}
'@

do {
    $windows = [OverlayWindowMetadata]::Read($ExcludedProcessId)
    ConvertTo-Json -InputObject @($windows) -Depth 4 -Compress
    if (-not $Once) { Start-Sleep -Milliseconds 100 }
} while (-not $Once)
