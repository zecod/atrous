// herdr-browser-host: the Browser panel's page, drawn natively. A WebView2 lives in a borderless
// popup owned by herdr's main window and kept exactly over the panel's page area. (Not a child
// window: herdr draws through DirectComposition above its child windows, so a child never shows.)
// The panel (browser-panel mod) says how big the area is and whether it shows; the host finds
// where it is in herdr's own frame. Agents drive the pages over the DevTools Protocol.
//
//   herdr-browser-host --home <herdr home> [--port 9335] [--cdp-port 9333] [--data <dir>] [--url <url>]
//                      [--herdr-pid <pid>] [--frames mods/browser-panel-frames] [--no-occlusion]
//
// API (127.0.0.1:<port>, JSON):
//   GET  /state?since=<ver>&wait=<ms>   what the host shows (long poll)
//   POST /place {visible, frozen, w, h, sig, keys?, stillShown?, pid?}   from the panel, on every change and each second
//   POST /tabs/new {url?, activate?} -> {id}    /tabs/activate {id}    /tabs/close {id}
//   POST /focus {page}   page: true puts the keyboard in the page, false gives it back to herdr
//   POST /still -> {path}   a still of the page, written where herdr can show it
//   POST /detect   find the page area again    POST /shutdown
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;

namespace HerdrBrowserHost;

sealed class Opt
{
    public string Home, Data, Url, Frames = "mods/browser-panel-frames", HerdrExe;
    public int Port = 9335, Cdp = 9333, HerdrPid;
    public bool NoOcclusion;

    public static Opt Parse(string[] a)
    {
        var o = new Opt();
        for (int i = 0; i < a.Length; i++)
        {
            string v() => i + 1 < a.Length ? a[++i] : "";
            switch (a[i])
            {
                case "--home": o.Home = v(); break;
                case "--data": o.Data = v(); break;
                case "--url": o.Url = v(); break;
                case "--frames": o.Frames = v(); break;
                case "--herdr-exe": o.HerdrExe = v(); break;
                case "--port": o.Port = int.Parse(v()); break;
                case "--cdp-port": o.Cdp = int.Parse(v()); break;
                case "--herdr-pid": o.HerdrPid = int.Parse(v()); break;
                case "--no-occlusion": o.NoOcclusion = true; break;
            }
        }
        var local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        o.Home ??= Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".config", "herdr-app");
        o.Data ??= Path.Combine(local, "herdr-browser", o.Port == 9335 ? "webview2" : $"webview2-{o.Port}");
        if (string.IsNullOrEmpty(o.HerdrExe))
        {
            var p = Path.Combine(local, "Programs", "herdr-app", "herdr-app.exe");
            o.HerdrExe = File.Exists(p) ? p : "herdr-app";
        }
        return o;
    }
}

sealed class Tab
{
    public string Id = "";
    public CoreWebView2Controller C;
    public CoreWebView2 W => C.CoreWebView2;
}

// The window the pages are drawn in: a borderless popup, owned by herdr's window while it shows
// (an owned window stays above its owner, hides with it when minimized, and keeps out of the taskbar).
sealed class ViewWindow : NativeWindow
{
    public Action Focused;
    public ViewWindow()
    {
        CreateHandle(new CreateParams
        {
            Caption = "Browser",
            Style = N.WS_POPUP | N.WS_CLIPCHILDREN,
            ExStyle = N.WS_EX_TOOLWINDOW,
            X = -32000,
            Y = -32000,
            Width = 800,
            Height = 600,
        });
    }
    protected override void WndProc(ref Message m)
    {
        if (m.Msg == N.WM_SETFOCUS) Focused?.Invoke();
        base.WndProc(ref m);
    }
}

sealed class Host : ApplicationContext
{
    static string logFile = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "herdr-browser", "host.log");
    public static void Log(string s)
    {
        try { File.AppendAllText(logFile, $"[{DateTime.Now:HH:mm:ss.fff}] {s}\n"); } catch { }
    }

    public static void LogTo(int port)
    {
        var dir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "herdr-browser");
        Directory.CreateDirectory(dir);
        logFile = Path.Combine(dir, port == 9335 ? "host.log" : $"host-{port}.log");
    }

    readonly Opt o;
    readonly SynchronizationContext ui;
    readonly ViewWindow view;
    readonly System.Windows.Forms.Timer timer;
    readonly Http http;
    readonly string run = DateTime.UtcNow.Ticks.ToString("x")[^7..];
    readonly string tmpDir;
    readonly string tabsFile;
    CoreWebView2Environment env;
    readonly List<Tab> tabs = new();
    Tab active;
    bool ready;
    string error;

    // herdr's window
    IntPtr herdr;
    bool embedded;
    long lastFind;
    Size lastClient;
    uint lastDpi = 96;
    N.POINT lastScreen;

    // what the panel asked for
    bool want, frozen;
    double areaW, areaH;
    string sig = "";
    Dictionary<string, string> keys = new(); // herdr's chords while the page has the keyboard -> their actions
    long lastPlace;
    string stillAck;

    // where the view is: the page area's top left in herdr's client pixels, found in herdr's own frame
    Point origin;
    bool originKnown;
    int marginRight; // client width - page area right edge, at the last detection (a window resize keeps it)
    string detectedKey = "";
    long detectAt;
    bool detecting;
    int detectTries;
    Rectangle cur; // the view's rect now (client pixels)
    bool shown;
    bool focused;

    // a still of the page, shown by the panel while something of herdr's must draw over the page
    enum Freeze { None, Capturing, WaitingAck, Verifying, Done }
    Freeze freeze;
    long freezeAt;
    string stillPath;
    int stillW, stillH, stillSeq;
    byte[] stillBytes;

    // herdr's overlays (dialogs, popups, windows): over the page they hide the view
    HashSet<string> overlaySet = new(), clearOverlays = new();
    bool overlayBlock, verifyPending, statusBusy;
    long lastStatus, lastVerify;

    // events for the panel (Ctrl+L, a new tab from the page, ...)
    readonly List<object> events = new();
    long eventSeq;

    long ver = 1;
    readonly object vlock = new();
    readonly List<TaskCompletionSource<bool>> waiters = new();

    NI.WinEventProc winEventProc;
    IntPtr winHook;
    N.HookProc mouseProc;
    IntPtr mouseHook;

    public Host(Opt o)
    {
        this.o = o;
        var local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        var baseDir = Path.Combine(local, "herdr-browser");
        Directory.CreateDirectory(baseDir);
        string suffix = o.Port == 9335 ? "" : $"-{o.Port}";
        tmpDir = Path.Combine(baseDir, $"tmp-host{suffix}");
        tabsFile = Path.Combine(baseDir, $"host-tabs{suffix}.json");
        Directory.CreateDirectory(tmpDir);
        Log($"start pid {Environment.ProcessId} api {o.Port} cdp {o.Cdp} home {o.Home} data {o.Data}");

        SynchronizationContext.SetSynchronizationContext(new WindowsFormsSynchronizationContext());
        ui = SynchronizationContext.Current;

        http = new Http(o.Port, Handle);
        http.Start(); // throws if the port is taken: another host serves it

        view = new ViewWindow();
        view.Focused = () => { try { active?.C.MoveFocus(CoreWebView2MoveFocusReason.Programmatic); } catch { } };
        CleanStills();

        timer = new System.Windows.Forms.Timer { Interval = 15 };
        timer.Tick += (_, _) => { try { Tick(); } catch (Exception e) { Log("tick " + e); } };
        timer.Start();


        // A press on the page makes it the active window (the keyboard follows), whichever app
        // was in front: herdr's window isn't active when the page is clicked from elsewhere.
        mouseProc = MouseHook;
        mouseHook = N.SetWindowsHookEx(N.WH_MOUSE_LL, mouseProc, N.GetModuleHandle(null), 0);

        ui.Post(async _ => await Init(), null);
    }

    IntPtr MouseHook(int code, IntPtr w, IntPtr l)
    {
        if (code >= 0 && shown)
        {
            int m = (int)w;
            if (m == N.WM_LBUTTONDOWN || m == N.WM_RBUTTONDOWN || m == N.WM_MBUTTONDOWN)
            {
                var p = Marshal.PtrToStructure<N.MSLLHOOKSTRUCT>(l).pt;
                if (N.GetWindowRect(view.Handle, out var r) && p.X >= r.Left && p.X < r.Right && p.Y >= r.Top && p.Y < r.Bottom)
                    ui.Post(_ => PressedInView(p), null);
            }
        }
        return N.CallNextHookEx(mouseHook, code, w, l);
    }

    void PressedInView(N.POINT p)
    {
        if (N.GetAncestor(N.WindowFromPoint(p), N.GA_ROOT) != view.Handle) return; // something above it took the press
        if (N.GetForegroundWindow() != view.Handle) FocusPage();
    }

    async Task Init()
    {
        try
        {
            Directory.CreateDirectory(o.Data);
            var args = $"--remote-debugging-port={o.Cdp} --remote-allow-origins=*";
            if (o.NoOcclusion) args += " --disable-features=CalculateNativeWinOcclusion";
            env = await CoreWebView2Environment.CreateAsync(null, o.Data, new CoreWebView2EnvironmentOptions(args));
            env.BrowserProcessExited += (_, e) => { Log($"browser process exited: {e.BrowserProcessExitKind}"); Quit(); };
            // the tabs open when the host last ran come back (a restart reloads them, nothing is lost)
            string[] urls = Array.Empty<string>();
            int activeAt = 0;
            try
            {
                var saved = JsonNode.Parse(File.ReadAllText(tabsFile));
                urls = (saved?["tabs"] as JsonArray)?.Select(x => (string)x).Where(u => !string.IsNullOrEmpty(u) && u != "about:blank").ToArray() ?? urls;
                activeAt = (int?)saved?["active"] ?? 0;
            }
            catch { }
            if (urls.Length == 0) await NewTab(string.IsNullOrEmpty(o.Url) ? "https://www.google.com" : o.Url, true);
            else for (int i = 0; i < urls.Length; i++) await NewTab(urls[i], i == Math.Clamp(activeAt, 0, urls.Length - 1));
            ready = true;
            SaveTabs();
            Log($"ready, browser {env.BrowserVersionString}");
        }
        catch (Exception e)
        {
            error = e.Message;
            Log("init failed: " + e);
        }
        Bump();
    }

    void Quit()
    {
        quitting = true;
        try { timer.Stop(); } catch { }
        try { if (winHook != IntPtr.Zero) NI.UnhookWinEvent(winHook); } catch { }
        try { if (mouseHook != IntPtr.Zero) N.UnhookWindowsHookEx(mouseHook); } catch { }
        try { foreach (var t in tabs.ToArray()) t.C.Close(); } catch { }
        Log("exit");
        ExitThread();
        Environment.Exit(0);
    }

    // ---- state ----

    void Bump()
    {
        TaskCompletionSource<bool>[] ws;
        lock (vlock)
        {
            ver++;
            ws = waiters.ToArray();
            waiters.Clear();
        }
        foreach (var w in ws) w.TrySetResult(true);
    }

    async Task WaitChange(long since, int ms)
    {
        var tcs = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        lock (vlock)
        {
            if (ver != since) return;
            waiters.Add(tcs);
        }
        await Task.WhenAny(tcs.Task, Task.Delay(ms));
    }

    void Event(string type, string arg = null)
    {
        events.Add(new { seq = ++eventSeq, type, arg });
        if (events.Count > 30) events.RemoveAt(0);
        Bump();
    }

    object Snapshot()
    {
        long v;
        lock (vlock) v = ver;
        return new
        {
            ok = true,
            ver = v,
            ready,
            error,
            pid = Environment.ProcessId,
            cdp = $"http://127.0.0.1:{o.Cdp}",
            herdr = herdr != IntPtr.Zero,
            view = (long)view.Handle,
            embedded,
            shown,
            focused,
            frozen,
            overlayBlock,
            overlays = overlaySet.ToArray(),
            scale = lastDpi / 96.0,
            rect = originKnown ? new { x = cur.X, y = cur.Y, w = cur.Width, h = cur.Height } : null,
            still = stillPath == null ? null : new { path = stillPath, w = stillW, h = stillH },
            active = active?.Id,
            tabs = tabs.Select(t => new { id = t.Id, active = t == active }).ToArray(),
            events = events.ToArray(),
            eventSeq,
            browser = env?.BrowserVersionString,
        };
    }

    Task<T> Ui<T>(Func<Task<T>> f)
    {
        var tcs = new TaskCompletionSource<T>(TaskCreationOptions.RunContinuationsAsynchronously);
        ui.Post(async _ =>
        {
            try { tcs.SetResult(await f()); }
            catch (Exception e) { tcs.SetException(e); }
        }, null);
        return tcs.Task;
    }

    Task<object> Ui(Func<object> f) => Ui(() => Task.FromResult(f()));

    // ---- API ----

    async Task<object> Handle(string method, string path, Dictionary<string, string> q, JsonObject b)
    {
        if (path == "/state" || path == "/health")
        {
            long since = q.TryGetValue("since", out var s) && long.TryParse(s, out var sv) ? sv : -1;
            int wait = q.TryGetValue("wait", out var w) && int.TryParse(w, out var wv) ? Math.Min(25000, wv) : 0;
            if (wait > 0) await WaitChange(since, wait);
            return await Ui(Snapshot);
        }
        if (method != "POST") throw new HttpError(405, "POST please");
        switch (path)
        {
            case "/place": return await Ui(() => { Place(b); return new { ok = true }; });
            case "/tabs/new":
                return await Ui(async () =>
                {
                    await WhenReady();
                    var t = await NewTab((string)b["url"] ?? "about:blank", (bool?)b["activate"] ?? true);
                    return (object)new { ok = true, id = t.Id };
                });
            case "/tabs/activate":
                return await Ui(() =>
                {
                    var t = tabs.FirstOrDefault(x => x.Id == (string)b["id"]) ?? throw new HttpError(404, "No such tab");
                    Activate(t);
                    return new { ok = true };
                });
            case "/tabs/close":
                return await Ui(() =>
                {
                    var t = tabs.FirstOrDefault(x => x.Id == (string)b["id"]) ?? throw new HttpError(404, "No such tab");
                    CloseTab(t);
                    return new { ok = true };
                });
            case "/focus":
                return await Ui(() =>
                {
                    if ((bool?)b["page"] ?? true) FocusPage();
                    else GiveBackFocus();
                    return new { ok = true };
                });
            case "/still":
                return await Ui(async () => { await CaptureStill(); return (object)new { ok = stillPath != null, path = stillPath, w = stillW, h = stillH }; });
            case "/detect":
                return await Ui(() => { detectedKey = ""; detectAt = 1; return new { ok = true }; });
            case "/shutdown":
                ui.Post(_ => Quit(), null);
                return new { ok = true };
        }
        throw new HttpError(404, $"Unknown {path}");
    }

    async Task WhenReady()
    {
        for (int i = 0; i < 200 && !ready && error == null; i++) await Task.Delay(50);
        if (!ready) throw new HttpError(503, error ?? "The browser isn't ready");
    }

    void Place(JsonObject b)
    {
        lastPlace = Environment.TickCount64;
        bool changed = false;
        bool v = (bool?)b["visible"] ?? want, f = (bool?)b["frozen"] ?? frozen;
        if (v != want || f != frozen) { want = v; frozen = f; changed = true; }
        if (b["w"] != null && b["h"] != null)
        {
            double w = (double)b["w"], h = (double)b["h"];
            if (Math.Abs(w - areaW) > 0.01 || Math.Abs(h - areaH) > 0.01) { areaW = w; areaH = h; changed = true; }
        }
        if (b["sig"] != null) sig = (string)b["sig"];
        // testing: a page area origin in client pixels, without looking for it
        if (b["ox"] != null && b["oy"] != null) { origin = new Point((int)b["ox"], (int)b["oy"]); originKnown = true; detectedKey = DetectKey(); changed = true; }
        if (b["keys"] is JsonArray ka)
        {
            var map = new Dictionary<string, string>();
            foreach (var k in ka)
            {
                if (k is JsonObject ko && (string)ko["k"] is string chord && (string)ko["a"] is string act) map[chord] = act;
            }
            keys = map;
        }
        if (b["stillShown"] != null) stillAck = (string)b["stillShown"];
        if (b["pid"] != null && (int)b["pid"] != o.HerdrPid) { o.HerdrPid = (int)b["pid"]; lastFind = 0; }
        if (DetectKey() != detectedKey && !detecting && detectAt == 0) detectAt = Environment.TickCount64 + 40;
        if (changed) Bump();
    }

    // ---- herdr's window ----

    void FindHerdr()
    {
        IntPtr best = IntPtr.Zero;
        long bestArea = 0;
        int candidates = 0;
        N.EnumWindows((h, _) =>
        {
            if (!N.IsWindowVisible(h) || N.ClassOf(h) != "Zed::Window") return true;
            N.GetWindowThreadProcessId(h, out uint pid);
            if (o.HerdrPid != 0 && pid != o.HerdrPid) return true;
            if (o.HerdrPid == 0)
            {
                try { if (!Process.GetProcessById((int)pid).ProcessName.Equals("herdr-app", StringComparison.OrdinalIgnoreCase)) return true; } catch { return true; }
            }
            candidates++;
            N.GetWindowRect(h, out var r);
            long area = (long)r.Width * r.Height;
            if (area > bestArea) { bestArea = area; best = h; }
            return true;
        }, IntPtr.Zero);
        // Without a pid, only a single herdr window is certain.
        if (o.HerdrPid == 0 && candidates != 1) best = IntPtr.Zero;
        if (best != herdr && best != IntPtr.Zero)
        {
            if (embedded) Unembed();
            herdr = best;
            lastClient = Size.Empty;
            Log($"herdr window {herdr} (pid {o.HerdrPid})");
            Bump();
        }
    }

    void Embed()
    {
        N.SetWindowLongPtr(view.Handle, -8 /* GWLP_HWNDPARENT: the owner */, herdr);
        N.SetWindowPos(view.Handle, IntPtr.Zero, 0, 0, 0, 0, N.SWP_NOMOVE | N.SWP_NOSIZE | N.SWP_NOACTIVATE | N.SWP_NOZORDER | N.SWP_HIDEWINDOW);
        shown = false;
        embedded = true;
        // herdr's window moving or resizing moves the view at once (the tick would trail it)
        N.GetWindowThreadProcessId(herdr, out uint pid);
        if (winHook != IntPtr.Zero) NI.UnhookWinEvent(winHook);
        winEventProc = OnWinEvent;
        winHook = NI.SetWinEventHook(NI.EVENT_OBJECT_LOCATIONCHANGE, NI.EVENT_OBJECT_LOCATIONCHANGE, IntPtr.Zero, winEventProc, pid, 0, NI.WINEVENT_OUTOFCONTEXT);
        Log($"owned by {herdr}");
        Bump();
    }

    void Unembed()
    {
        SetShown(false);
        N.SetWindowLongPtr(view.Handle, -8, IntPtr.Zero);
        embedded = false;
        Log("unembedded");
        Bump();
    }

    void OnWinEvent(IntPtr hook, uint ev, IntPtr hwnd, int idObject, int idChild, uint thread, uint time)
    {
        if (hwnd != herdr || idObject != 0) return;
        try { Follow(); } catch { }
    }

    // Keep the view on the page area as herdr's window moves.
    void Follow()
    {
        var p = new N.POINT();
        N.ClientToScreen(herdr, ref p);
        if (p.X == lastScreen.X && p.Y == lastScreen.Y) return;
        lastScreen = p;
        if (shown) { var at = Screen(cur.Location); N.SetWindowPos(view.Handle, IntPtr.Zero, at.X, at.Y, cur.Width, cur.Height, N.SWP_NOACTIVATE | N.SWP_NOOWNERZORDER | N.SWP_NOZORDER); }
        foreach (var t in tabs) { try { t.C.NotifyParentWindowPositionChanged(); } catch { } }
    }

    string DetectKey() => $"{Math.Round(areaW * 4)}x{Math.Round(areaH * 4)}|{lastClient.Width}x{lastClient.Height}|{lastDpi}|{sig}";

    void Tick()
    {
        long now = Environment.TickCount64;
        if (herdr != IntPtr.Zero && !N.IsWindow(herdr))
        {
            Log("herdr window closed");
            embedded = false;
            shown = false;
            herdr = IntPtr.Zero;
            originKnown = false;
            Bump();
        }
        if (herdr == IntPtr.Zero && now - lastFind > 1000) { lastFind = now; FindHerdr(); }
        bool ok = herdr != IntPtr.Zero && N.IsWindowVisible(herdr) && !N.IsIconic(herdr);
        if (ok)
        {
            if (!embedded) Embed();
            N.GetClientRect(herdr, out var cr);
            var client = new Size(cr.Width, cr.Height);
            uint dpi = N.GetDpiForWindow(herdr);
            if (client != lastClient || dpi != lastDpi)
            {
                // A resize keeps the side panel's distance from the window's right edge: follow it now,
                // and look again in herdr's frame once the size settles.
                if (originKnown && dpi == lastDpi && lastClient != Size.Empty)
                {
                    int w = (int)Math.Round(areaW * dpi / 96.0);
                    origin = new Point(client.Width - marginRight - w, origin.Y);
                }
                if (dpi != lastDpi) originKnown = false;
                lastClient = client;
                lastDpi = dpi;
                detectAt = now + 200;
            }
            Follow();
        }
        if (detectAt != 0 && now >= detectAt && ok && !detecting && areaW > 0) { detectAt = 0; _ = Detect(); }

        bool alive = now - lastPlace < 4000;
        bool target = ok && want && alive && originKnown && areaW >= 20 && areaH >= 20 && ready && active != null;
        if (!target)
        {
            freeze = Freeze.None;
            SetShown(false);
        }
        else if (!frozen && !overlayBlock)
        {
            freeze = Freeze.None;
            Move();
            SetShown(true);
        }
        else StepFreeze(now);

        if (target || overlayBlock) PollOverlays(now);
        if (overlayBlock && freeze == Freeze.Done && !frozen && (verifyPending || now - lastVerify > 1500) && now - freezeAt > 150 && !detecting)
        {
            verifyPending = false;
            lastVerify = now;
            _ = VerifyOverlays();
        }
    }

    // Where a point of herdr's client area is for the view's own SetWindowPos.
    Point Screen(Point p)
    {
        var q = new N.POINT { X = p.X, Y = p.Y };
        N.ClientToScreen(herdr, ref q);
        return new Point(q.X, q.Y);
    }

    Rectangle WantRect()
    {
        double s = lastDpi / 96.0;
        int w = (int)Math.Round(areaW * s), h = (int)Math.Round(areaH * s);
        return new Rectangle(origin.X, origin.Y, w, h);
    }

    void Move()
    {
        var r = WantRect();
        if (r == cur) return;
        cur = r;
        var at = Screen(r.Location);
        N.SetWindowPos(view.Handle, IntPtr.Zero, at.X, at.Y, r.Width, r.Height, N.SWP_NOACTIVATE | N.SWP_NOOWNERZORDER | N.SWP_NOZORDER);
        foreach (var t in tabs) { try { t.C.Bounds = new Rectangle(0, 0, r.Width, r.Height); } catch { } }
        Bump();
    }

    // The QPC clock in 100 ns ticks (what Windows.Graphics.Capture stamps frames with).
    static long Qpc() => (long)(Stopwatch.GetTimestamp() * (10_000_000.0 / Stopwatch.Frequency));

    void SetShown(bool v)
    {
        if (v == shown) return;
        Log($"view {(v ? "shown" : "hidden")} qpc {Qpc()}");
        if (!v && ViewHasFocus()) GiveBackFocus();
        shown = v;
        if (v)
        {
            Move();
            var at = Screen(cur.Location);
            N.SetWindowPos(view.Handle, IntPtr.Zero, at.X, at.Y, cur.Width, cur.Height, N.SWP_NOACTIVATE | N.SWP_NOOWNERZORDER | N.SWP_SHOWWINDOW);
            try { if (active != null) active.C.IsVisible = true; } catch { }
        }
        else
        {
            N.SetWindowPos(view.Handle, IntPtr.Zero, 0, 0, 0, 0, N.SWP_NOMOVE | N.SWP_NOSIZE | N.SWP_NOACTIVATE | N.SWP_NOZORDER | N.SWP_HIDEWINDOW);
        }
        Bump();
    }

    // ---- finding the page area in herdr's own frame ----
    // The panel draws a magenta square in the page area's top left corner and a cyan one in its
    // bottom right, under the view. `herdr-app shot` is herdr's own rendering, with them in it.

    // herdr's own socket (<home>/herdr-app.sock): one JSON request, the reply, then it closes.
    // What `herdr-app status` and `herdr-app shot` send, without starting a process each time.
    async Task<string> HerdrSocket(string json, int ms = 3000)
    {
        using var sock = new System.Net.Sockets.Socket(System.Net.Sockets.AddressFamily.Unix, System.Net.Sockets.SocketType.Stream, System.Net.Sockets.ProtocolType.Unspecified);
        using var cts = new CancellationTokenSource(ms);
        await sock.ConnectAsync(new System.Net.Sockets.UnixDomainSocketEndPoint(Path.Combine(o.Home, "herdr-app.sock")), cts.Token);
        await sock.SendAsync(Encoding.UTF8.GetBytes(json + "\n"), System.Net.Sockets.SocketFlags.None, cts.Token);
        var ms2 = new MemoryStream();
        var buf = new byte[16384];
        for (;;)
        {
            int n = await sock.ReceiveAsync(buf, System.Net.Sockets.SocketFlags.None, cts.Token);
            if (n <= 0) break;
            ms2.Write(buf, 0, n);
        }
        return Encoding.UTF8.GetString(ms2.ToArray());
    }

    bool socketOk = true;

    async Task<string[]> Overlays()
    {
        if (socketOk)
        {
            try { return (JsonNode.Parse(await HerdrSocket("{\"status\":true}"))?["overlays"] as JsonArray)?.Select(x => (string)x).ToArray() ?? Array.Empty<string>(); }
            catch (Exception e) { socketOk = false; Log("herdr socket: " + e.Message + " (using the CLI)"); }
        }
        var (code, stdout) = await Herdr("status");
        return code == 0 ? (JsonNode.Parse(stdout)?["overlays"] as JsonArray)?.Select(x => (string)x).ToArray() ?? Array.Empty<string>() : null;
    }

    async Task<(int code, string stdout)> Herdr(params string[] args)
    {
        var psi = new ProcessStartInfo(o.HerdrExe) { RedirectStandardOutput = true, RedirectStandardError = true, UseShellExecute = false, CreateNoWindow = true };
        foreach (var a in args) psi.ArgumentList.Add(a);
        psi.Environment["HERDR_APP_HOME"] = o.Home;
        using var p = Process.Start(psi);
        var stdout = p.StandardOutput.ReadToEndAsync();
        var stderr = p.StandardError.ReadToEndAsync();
        await p.WaitForExitAsync();
        return (p.ExitCode, await stdout);
    }

    async Task<Bitmap> Shot()
    {
        var file = Path.Combine(tmpDir, "shot.png");
        try { File.Delete(file); } catch { }
        bool done = false;
        if (socketOk)
        {
            try { await HerdrSocket(new JsonObject { ["shot"] = file }.ToJsonString()); done = File.Exists(file); }
            catch (Exception e) { Log("herdr socket shot: " + e.Message); }
        }
        if (!done)
        {
            var (code, _) = await Herdr("shot", file);
            if (code != 0) return null;
        }
        if (!File.Exists(file)) return null;
        var bytes = await File.ReadAllBytesAsync(file);
        using var ms = new MemoryStream(bytes);
        return new Bitmap(ms);
    }

    async Task Detect()
    {
        detecting = true;
        var key = DetectKey();
        try
        {
            using var bmp = await Shot();
            if (bmp == null) { Log("detect: no shot"); detectAt = Environment.TickCount64 + 500; return; }
            var found = await Task.Run(() => FindMarkers(bmp));
            double s = lastDpi / 96.0;
            int ew = (int)Math.Round(areaW * s), eh = (int)Math.Round(areaH * s);
            if (found is Rectangle r && Math.Abs(r.Width - ew) <= 3 && Math.Abs(r.Height - eh) <= 3)
            {
                bool moved = !originKnown || origin != r.Location;
                origin = r.Location;
                originKnown = true;
                marginRight = lastClient.Width - (r.X + ew);
                detectedKey = key;
                detectTries = 0;
                if (moved) Log($"page area at {r.X},{r.Y} {r.Width}x{r.Height} (panel says {ew}x{eh}, client {lastClient.Width}x{lastClient.Height}, shot {bmp.Width}x{bmp.Height})");
                Bump();
            }
            else
            {
                // herdr may not have drawn the new layout yet: look again shortly
                if (++detectTries <= 8) detectAt = Environment.TickCount64 + 120 * detectTries;
                if (detectTries == 1 || detectTries == 8) Log($"detect: {(found is Rectangle rr ? $"found {rr} but the panel says {ew}x{eh}" : "markers not found")} (try {detectTries})");
            }
        }
        catch (Exception e) { Log("detect " + e.Message); detectAt = Environment.TickCount64 + 1000; }
        finally { detecting = false; }
    }

    static Rectangle? FindMarkers(Bitmap bmp)
    {
        var data = bmp.LockBits(new Rectangle(0, 0, bmp.Width, bmp.Height), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
        try
        {
            int w = bmp.Width, h = bmp.Height, stride = data.Stride;
            var px = new byte[stride * h];
            Marshal.Copy(data.Scan0, px, 0, px.Length);
            // BGRA
            bool Is(int x, int y, int r, int g, int b)
            {
                if (x < 0 || y < 0 || x >= w || y >= h) return false;
                int i = y * stride + x * 4;
                return Math.Abs(px[i + 2] - r) <= 3 && Math.Abs(px[i + 1] - g) <= 3 && Math.Abs(px[i] - b) <= 3;
            }
            // coverage of marker color m over the background next to it
            double Cover(int x, int y, (int r, int g, int b) m, (int r, int g, int b) bg)
            {
                if (x < 0 || y < 0 || x >= w || y >= h) return 0;
                int i = y * stride + x * 4;
                double dr = m.r - bg.r, dg = m.g - bg.g, db = m.b - bg.b, den = dr * dr + dg * dg + db * db;
                if (den < 1) return 0;
                return ((px[i + 2] - bg.r) * dr + (px[i + 1] - bg.g) * dg + (px[i] - bg.b) * db) / den;
            }
            (int, int, int) At(int x, int y) { int i = Math.Clamp(y, 0, h - 1) * stride + Math.Clamp(x, 0, w - 1) * 4; return (px[i + 2], px[i + 1], px[i]); }
            int ax = -1, ay = -1, bx = -1, by = -1;
            // first 2x2 magenta block, scanning rows top down
            for (int y = 0; y < h - 1 && ax < 0; y++)
                for (int x = 0; x < w - 1; x++)
                    if (Is(x, y, 255, 0, 255) && Is(x + 1, y, 255, 0, 255) && Is(x, y + 1, 255, 0, 255) && Is(x + 1, y + 1, 255, 0, 255)) { ax = x; ay = y; break; }
            if (ax < 0) return null;
            // last 2x2 cyan block, scanning rows bottom up
            for (int y = h - 1; y > 0 && bx < 0; y--)
                for (int x = w - 1; x > 0; x--)
                    if (Is(x, y, 0, 255, 255) && Is(x - 1, y, 0, 255, 255) && Is(x, y - 1, 0, 255, 255) && Is(x - 1, y - 1, 0, 255, 255)) { bx = x; by = y; break; }
            if (bx < 0 || bx <= ax || by <= ay) return null;
            // a partly covered pixel at an edge belongs to the area if the square covers half of it
            var bgA = At(ax + 12, ay + 12);
            if (Cover(ax - 1, ay + 1, (255, 0, 255), bgA) >= 0.5) ax--;
            if (Cover(ax + 1, ay - 1, (255, 0, 255), bgA) >= 0.5) ay--;
            var bgB = At(bx - 12, by - 12);
            if (Cover(bx + 1, by - 1, (0, 255, 255), bgB) >= 0.5) bx++;
            if (Cover(bx - 1, by + 1, (0, 255, 255), bgB) >= 0.5) by++;
            return new Rectangle(ax, ay, bx - ax + 1, by - ay + 1);
        }
        finally { bmp.UnlockBits(data); }
    }

    // ---- stills ----

    void CleanStills()
    {
        try
        {
            var dir = Path.Combine(o.Home, o.Frames.Replace('/', Path.DirectorySeparatorChar), "still");
            if (Directory.Exists(dir))
                foreach (var f in Directory.GetFiles(dir, "st*.*", SearchOption.AllDirectories)) File.Delete(f);
        }
        catch { }
    }

    // One still per folder (s00..s03 round robin), each with a new name: herdr reloads the images
    // in a folder where a file changes, so a still never shares a folder with the one on screen.
    async Task CaptureStill()
    {
        var t = active;
        if (t == null) return;
        var ms = new MemoryStream();
        await t.W.CapturePreviewAsync(CoreWebView2CapturePreviewImageFormat.Png, ms); // lossless: the swap back is pixel exact
        var bytes = ms.ToArray();
        if (bytes.Length < 100) return;
        stillSeq++;
        string bucket = $"s{stillSeq % 4:00}", name = $"st{run}-{stillSeq}.png";
        var rel = $"{o.Frames}/still/{bucket}";
        var dir = Path.Combine(o.Home, rel.Replace('/', Path.DirectorySeparatorChar));
        Directory.CreateDirectory(dir);
        foreach (var f in Directory.GetFiles(dir, "st*.*")) { try { File.Delete(f); } catch { } }
        var tmp = Path.Combine(tmpDir, name + ".part");
        await File.WriteAllBytesAsync(tmp, bytes);
        File.Move(tmp, Path.Combine(dir, name), true);
        int w = cur.Width, h = cur.Height;
        try { using var img = Image.FromStream(new MemoryStream(bytes)); w = img.Width; h = img.Height; } catch { }
        stillBytes = bytes;
        stillPath = $"{rel}/{name}";
        stillW = w;
        stillH = h;
        Bump();
    }

    async void StepFreeze(long now)
    {
        switch (freeze)
        {
            case Freeze.None:
                if (!shown) { freeze = Freeze.Done; freezeAt = now; return; }
                freeze = Freeze.Capturing;
                try { await CaptureStill(); } catch (Exception e) { Log("still " + e.Message); }
                if (freeze == Freeze.Capturing) { freeze = Freeze.WaitingAck; freezeAt = Environment.TickCount64; }
                break;
            case Freeze.WaitingAck:
                // the panel says the still is drawn (or half a second went by): look for it in herdr's frame
                if ((stillPath != null && stillAck == stillPath) || now - freezeAt > 500)
                {
                    freeze = Freeze.Verifying;
                    freezeAt = now;
                    _ = HideOverStill();
                }
                break;
        }
    }

    // The view hides only once herdr's own frame shows the still where the page is: the marker
    // squares under it are covered then. (Hiding on the panel's word alone showed herdr's bare
    // page area for ~80 ms while the picture was still being decoded: the annotate flicker.)
    async Task HideOverStill()
    {
        long start = Environment.TickCount64;
        int looks = 0;
        bool seen = false;
        while (freeze == Freeze.Verifying && Environment.TickCount64 - start < 700)
        {
            looks++;
            try
            {
                using var shot = await Shot();
                if (shot != null && !MarkersShowing(shot, cur)) { seen = true; await Task.Delay(20); break; } // and one more frame to reach the screen
            }
            catch { }
            await Task.Delay(15);
        }
        if (freeze != Freeze.Verifying) return; // unfrozen meanwhile
        Log($"still {(seen ? "on screen" : "not seen")} after {looks} look(s), {Environment.TickCount64 - start} ms");
        SetShown(false);
        freeze = Freeze.Done;
        freezeAt = Environment.TickCount64;
    }

    // Is either marker square (top left magenta, bottom right cyan) visible in herdr's frame? By hue:
    // a dialog's dimming backdrop darkens them but keeps them magenta and cyan.
    static bool MarkersShowing(Bitmap bmp, Rectangle r)
    {
        bool Magenta(int x, int y)
        {
            if (x < 0 || y < 0 || x >= bmp.Width || y >= bmp.Height) return false;
            var c = bmp.GetPixel(x, y);
            return c.R - c.G > 35 && c.B - c.G > 35 && Math.Abs(c.R - c.B) < 30;
        }
        bool Cyan(int x, int y)
        {
            if (x < 0 || y < 0 || x >= bmp.Width || y >= bmp.Height) return false;
            var c = bmp.GetPixel(x, y);
            return c.G - c.R > 35 && c.B - c.R > 35 && Math.Abs(c.G - c.B) < 30;
        }
        return (Magenta(r.X + 2, r.Y + 2) && Magenta(r.X + 1, r.Y + 3))
            || (Cyan(r.Right - 3, r.Bottom - 3) && Cyan(r.Right - 2, r.Bottom - 4));
    }

    // ---- overlays ----

    void PollOverlays(long now)
    {
        if (statusBusy || now - lastStatus < 150) return;
        // Overlays open from the person's use of the window (or a command); while herdr (or the
        // page) isn't in front, look less often.
        var fg = N.GetForegroundWindow();
        bool front = fg == herdr || fg == view.Handle || N.GetAncestor(fg, N.GA_ROOT) == herdr;
        if (!front && now - lastStatus < 1000) return;
        statusBusy = true;
        lastStatus = now;
        Task.Run(async () =>
        {
            string[] list = null;
            try { list = await Overlays(); }
            catch { }
            ui.Post(_ => { statusBusy = false; if (list != null) OnOverlays(list); }, null);
        });
    }

    void OnOverlays(string[] list)
    {
        var set = new HashSet<string>(list);
        if (set.SetEquals(overlaySet)) return;
        Log($"overlays: [{string.Join(", ", list)}]");
        overlaySet = set;
        if (set.Count == 0) { clearOverlays.Clear(); overlayBlock = false; }
        else if (set.IsSubsetOf(clearOverlays)) overlayBlock = false;
        else { overlayBlock = true; verifyPending = true; }
        Bump();
    }

    // With the view hidden and the still drawn by herdr in its place: does herdr's frame show the
    // still there, untouched? Then the overlays are elsewhere and the view can come back.
    async Task VerifyOverlays()
    {
        var still = stillBytes;
        var r = cur;
        if (still == null || r.Width < 20 || r.Height < 20) return;
        try
        {
            using var shot = await Shot();
            if (shot == null) return;
            bool clear = await Task.Run(() => Same(shot, r, still));
            Log($"overlays [{string.Join(", ", overlaySet)}] {(clear ? "clear of" : "over")} the page");
            if (clear && overlayBlock)
            {
                clearOverlays.UnionWith(overlaySet);
                overlayBlock = false;
                Bump();
            }
        }
        catch (Exception e) { Log("verify " + e.Message); }
    }

    static bool Same(Bitmap shot, Rectangle r, byte[] stillJpeg)
    {
        using var still0 = new Bitmap(new MemoryStream(stillJpeg));
        using var still = new Bitmap(still0, r.Width, r.Height);
        const int B = 16;
        int bw = r.Width / B, bh = r.Height / B;
        var a = Lum(shot, r);
        var b = Lum(still, new Rectangle(0, 0, r.Width, r.Height));
        for (int by = 0; by < bh; by++)
            for (int bx = 0; bx < bw; bx++)
            {
                long d = 0;
                for (int y = by * B; y < by * B + B; y++)
                    for (int x = bx * B; x < bx * B + B; x++)
                        d += Math.Abs(a[y * r.Width + x] - b[y * r.Width + x]);
                if (d / (B * B) > 24) return false;
            }
        return true;
    }

    static int[] Lum(Bitmap bmp, Rectangle r)
    {
        r.Intersect(new Rectangle(0, 0, bmp.Width, bmp.Height));
        var data = bmp.LockBits(r, ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
        try
        {
            var px = new byte[data.Stride * r.Height];
            Marshal.Copy(data.Scan0, px, 0, px.Length);
            var o = new int[r.Width * r.Height];
            for (int y = 0; y < r.Height; y++)
                for (int x = 0; x < r.Width; x++)
                {
                    int i = y * data.Stride + x * 4;
                    o[y * r.Width + x] = (px[i + 2] * 3 + px[i + 1] * 6 + px[i]) / 10;
                }
            return o;
        }
        finally { bmp.UnlockBits(data); }
    }

    // ---- tabs ----

    async Task<Tab> NewTab(string url, bool activate)
    {
        var c = await env.CreateCoreWebView2ControllerAsync(view.Handle);
        var t = new Tab { C = c };
        c.DefaultBackgroundColor = Color.White;
        c.IsVisible = false;
        c.Bounds = new Rectangle(0, 0, Math.Max(1, cur.Width), Math.Max(1, cur.Height));
        var w = c.CoreWebView2;
        w.Settings.IsStatusBarEnabled = true;
        w.Settings.AreDevToolsEnabled = true;
        await RefreshId(t);
        w.NewWindowRequested += async (_, e) =>
        {
            var d = e.GetDeferral();
            try
            {
                var nt = await NewTab(null, true);
                e.NewWindow = nt.W;
                e.Handled = true;
                Event("tab", nt.Id);
            }
            catch (Exception ex) { Log("new window: " + ex.Message); }
            finally { d.Complete(); }
            // An adopted popup gets the opener's new page target: its id changes once it's in.
            foreach (var ms in new[] { 150, 600, 2000 })
            {
                await Task.Delay(ms);
                foreach (var x in tabs.ToArray()) await RefreshId(x);
            }
        };
        w.WindowCloseRequested += (_, _) => CloseTab(t);
        w.SourceChanged += (_, _) => SaveTabs();
        c.AcceleratorKeyPressed += (_, e) => OnKey(t, e);
        c.GotFocus += (_, _) => { focused = true; Bump(); };
        c.LostFocus += (_, _) => { focused = false; Bump(); };
        tabs.Add(t);
        if (activate) Activate(t);
        if (!string.IsNullOrEmpty(url)) w.Navigate(url);
        Log($"tab {t.Id} {url}");
        Bump();
        return t;
    }

    // The page's DevTools target id (the helper and agents know a tab by it).
    async Task RefreshId(Tab t)
    {
        try
        {
            var info = await t.W.CallDevToolsProtocolMethodAsync("Target.getTargetInfo", "{}");
            var id = (string)JsonNode.Parse(info)?["targetInfo"]?["targetId"] ?? "";
            if (id != "" && id != t.Id)
            {
                if (t.Id != "") Log($"tab {t.Id} is now {id}");
                t.Id = id;
                Bump();
            }
        }
        catch (Exception e) { Log("target id: " + e.Message); }
    }

    bool quitting;

    void SaveTabs()
    {
        if (!ready || quitting) return; // closing the tabs on the way out isn't a change to remember
        try
        {
            var json = new JsonObject
            {
                ["tabs"] = new JsonArray(tabs.Select(t => (JsonNode)(t.W?.Source ?? "")).ToArray()),
                ["active"] = Math.Max(0, tabs.IndexOf(active)),
            };
            var tmp = tabsFile + ".tmp";
            File.WriteAllText(tmp, json.ToJsonString());
            File.Move(tmp, tabsFile, true);
        }
        catch { }
    }

    void Activate(Tab t)
    {
        if (active == t) return;
        var old = active;
        active = t;
        try
        {
            t.C.Bounds = new Rectangle(0, 0, Math.Max(1, cur.Width), Math.Max(1, cur.Height));
            t.C.IsVisible = true;
            if (old != null) old.C.IsVisible = false;
            if (old != null && ViewHasFocus()) t.C.MoveFocus(CoreWebView2MoveFocusReason.Programmatic);
        }
        catch (Exception e) { Log("activate " + e.Message); }
        SaveTabs();
        Bump();
    }

    void CloseTab(Tab t)
    {
        int i = tabs.IndexOf(t);
        if (i < 0) return;
        tabs.RemoveAt(i);
        if (active == t)
        {
            active = null;
            if (tabs.Count > 0) Activate(tabs[Math.Min(i, tabs.Count - 1)]);
        }
        try { t.C.Close(); } catch { }
        Log($"closed tab {t.Id}");
        SaveTabs();
        if (tabs.Count == 0 && ready) _ = NewTab("about:blank", true);
        Bump();
    }

    // ---- keyboard and focus ----

    // The page has the keyboard when the view is the active window (clicking it activates it;
    // clicking herdr activates herdr again, as with any two windows).
    bool ViewHasFocus() => N.GetForegroundWindow() == view.Handle;

    // The keyboard into the page: a plain request to make the view the active window (Windows
    // grants it or not; nothing is typed or joined), then the page's own focus.
    void FocusPage()
    {
        if (!shown || active == null) return;
        NI.SetForegroundWindow(view.Handle);
        try { active.C.MoveFocus(CoreWebView2MoveFocusReason.Programmatic); } catch { }
        if (N.GetForegroundWindow() != view.Handle) Log("couldn't make the page the active window");
    }

    void GiveBackFocus()
    {
        if (herdr != IntPtr.Zero && ViewHasFocus()) NI.SetForegroundWindow(herdr);
    }

    static readonly Dictionary<uint, string> Named = new()
    {
        [0x08] = "backspace", [0x09] = "tab", [0x0D] = "enter", [0x1B] = "escape", [0x20] = "space",
        [0x21] = "pageup", [0x22] = "pagedown", [0x23] = "end", [0x24] = "home",
        [0x25] = "left", [0x26] = "up", [0x27] = "right", [0x28] = "down", [0x2D] = "insert", [0x2E] = "delete",
    };

    static string KeyName(uint vk, uint scan)
    {
        if (Named.TryGetValue(vk, out var n)) return n;
        if (vk >= 0x70 && vk <= 0x87) return $"f{vk - 0x6F}";
        if (vk >= 0x60 && vk <= 0x69) return ((char)('0' + vk - 0x60)).ToString();
        var buf = new StringBuilder(8);
        int r = N.ToUnicodeEx(vk, scan, new byte[256], buf, buf.Capacity, 4, N.GetKeyboardLayout(0));
        if (r == 1 && !char.IsControl(buf[0])) return char.ToLowerInvariant(buf[0]).ToString();
        return null;
    }

    static string Chord(uint vk, uint scan)
    {
        if (vk == 0x10 || vk == 0x11 || vk == 0x12 || vk == 0x5B || vk == 0x5C || (vk >= 0xA0 && vk <= 0xA5)) return null;
        var key = KeyName(vk, scan);
        if (key == null) return null;
        var mods = new List<string>();
        if (N.Down(N.VK_MENU)) mods.Add("alt");
        if (N.Down(N.VK_LWIN) || N.Down(N.VK_RWIN)) mods.Add("cmd");
        if (N.Down(N.VK_CONTROL)) mods.Add("ctrl");
        if (N.Down(N.VK_SHIFT)) mods.Add("shift");
        mods.Sort(StringComparer.Ordinal);
        mods.Add(key);
        return string.Join("-", mods);
    }

    async Task RunAction(string chord, string action)
    {
        try
        {
            await HerdrSocket(new JsonObject { ["do"] = action, ["args"] = null }.ToJsonString());
            Log($"key {chord} -> {action}");
        }
        catch (Exception x) { Log($"key {chord} -> {action} failed: {x.Message}"); }
    }

    void OnKey(Tab t, CoreWebView2AcceleratorKeyPressedEventArgs e)
    {
        if (e.KeyEventKind != CoreWebView2KeyEventKind.KeyDown && e.KeyEventKind != CoreWebView2KeyEventKind.SystemKeyDown) return;
        var ks = e.PhysicalKeyStatus;
        var chord = Chord(e.VirtualKey, ks.ScanCode);
        if (chord == null) return;
        // the browser's own keys that the panel answers
        if (chord == "ctrl-l" || chord == "alt-d" || chord == "f6") { e.Handled = true; GiveBackFocus(); Event("url"); Log($"key {chord} -> address bar"); return; }
        if (chord == "ctrl-t") { e.Handled = true; Event("new-tab"); return; }
        if (chord == "ctrl-w" || chord == "ctrl-f4") { e.Handled = true; CloseTab(t); return; }
        if (!keys.TryGetValue(chord, out var action)) return;
        // "terminal" and "send:" keys belong to whatever has the keyboard: here, the page.
        if (action == "terminal" || action.StartsWith("send:")) return;
        // herdr's keys do what they do in herdr: its window comes back in front and the bound
        // action runs through its socket (the action, never a re-typed key).
        e.Handled = true;
        GiveBackFocus();
        _ = RunAction(chord, action);
    }
}

static class Program
{
    [STAThread]
    static int Main(string[] args)
    {
        var o = Opt.Parse(args);
        Host.LogTo(o.Port);
        Application.SetHighDpiMode(HighDpiMode.PerMonitorV2);
        Application.SetUnhandledExceptionMode(UnhandledExceptionMode.CatchException);
        Application.ThreadException += (_, e) => Host.Log("ui exception " + e.Exception);
        AppDomain.CurrentDomain.UnhandledException += (_, e) => Host.Log("fatal " + e.ExceptionObject);
        Host host;
        try { host = new Host(o); }
        catch (System.Net.Sockets.SocketException) { Host.Log($"port {o.Port} is taken: another host runs"); return 3; }
        Application.Run(host);
        return 0;
    }
}
