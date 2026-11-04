using System;
using System.Runtime.InteropServices;

namespace HerdrBrowserHost;

// Window activation and window event hooks. (Nothing here types or clicks: the host never injects input.)
static class NI
{
    public const uint EVENT_OBJECT_LOCATIONCHANGE = 0x800B, WINEVENT_OUTOFCONTEXT = 0;
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
    public delegate void WinEventProc(IntPtr hook, uint ev, IntPtr hwnd, int idObject, int idChild, uint thread, uint time);
    [DllImport("user32.dll")] public static extern IntPtr SetWinEventHook(uint min, uint max, IntPtr mod, WinEventProc f, uint pid, uint tid, uint flags);
    [DllImport("user32.dll")] public static extern bool UnhookWinEvent(IntPtr h);

}
