using System;
using System.Collections.Generic;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Threading.Tasks;

namespace AtrousBrowserHost;

sealed class HttpError : Exception
{
    public int Status { get; }
    public HttpError(int status, string message) : base(message) { Status = status; }
}

// A small HTTP/1.1 server on 127.0.0.1: one request per connection, JSON in and out.
sealed class Http
{
    public delegate Task<object> Handler(string method, string path, Dictionary<string, string> query, JsonObject body);

    readonly TcpListener listener;
    readonly Handler handler;
    static readonly JsonSerializerOptions Json = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };

    public Http(int port, Handler handler)
    {
        listener = new TcpListener(IPAddress.Loopback, port);
        this.handler = handler;
    }

    public void Start()
    {
        listener.Start();
        _ = Task.Run(Loop);
    }

    async Task Loop()
    {
        for (;;)
        {
            TcpClient c;
            try { c = await listener.AcceptTcpClientAsync(); }
            catch { return; }
            _ = Task.Run(() => Serve(c));
        }
    }

    static int Find(byte[] b, int len, byte[] pat)
    {
        for (int i = 0; i + pat.Length <= len; i++)
        {
            int k = 0;
            while (k < pat.Length && b[i + k] == pat[k]) k++;
            if (k == pat.Length) return i;
        }
        return -1;
    }

    static readonly byte[] End = Encoding.ASCII.GetBytes("\r\n\r\n");

    async Task Serve(TcpClient c)
    {
        using (c)
        {
            c.NoDelay = true;
            var s = c.GetStream();
            var buf = new byte[32768];
            int len = 0, head = -1;
            try
            {
                while (head < 0)
                {
                    int n = await s.ReadAsync(buf.AsMemory(len, buf.Length - len));
                    if (n <= 0) return;
                    len += n;
                    head = Find(buf, len, End);
                    if (head < 0 && len == buf.Length) return;
                }
                var lines = Encoding.ASCII.GetString(buf, 0, head).Split("\r\n");
                var first = lines[0].Split(' ');
                if (first.Length < 2) return;
                string method = first[0], target = first[1];
                int clen = 0;
                for (int i = 1; i < lines.Length; i++)
                {
                    int k = lines[i].IndexOf(':');
                    if (k > 0 && lines[i][..k].Trim().Equals("content-length", StringComparison.OrdinalIgnoreCase))
                        int.TryParse(lines[i][(k + 1)..].Trim(), out clen);
                }
                var body = new byte[clen];
                int have = Math.Min(clen, len - head - 4);
                Array.Copy(buf, head + 4, body, 0, have);
                while (have < clen)
                {
                    int n = await s.ReadAsync(body.AsMemory(have, clen - have));
                    if (n <= 0) return;
                    have += n;
                }
                string path = target, qs = "";
                int q = target.IndexOf('?');
                if (q >= 0) { path = target[..q]; qs = target[(q + 1)..]; }
                var query = new Dictionary<string, string>();
                foreach (var kv in qs.Split('&', StringSplitOptions.RemoveEmptyEntries))
                {
                    int e = kv.IndexOf('=');
                    if (e < 0) query[Uri.UnescapeDataString(kv)] = "";
                    else query[Uri.UnescapeDataString(kv[..e])] = Uri.UnescapeDataString(kv[(e + 1)..].Replace('+', ' '));
                }
                JsonObject json = new();
                if (clen > 0)
                {
                    try { json = JsonNode.Parse(body) as JsonObject ?? new JsonObject(); }
                    catch { await Write(s, 400, new { ok = false, error = "bad JSON" }); return; }
                }
                object result;
                int status = 200;
                try { result = await handler(method, path, query, json) ?? new { ok = true }; }
                catch (HttpError e) { status = e.Status; result = new { ok = false, error = e.Message }; }
                catch (Exception e) { status = 500; result = new { ok = false, error = e.Message }; }
                await Write(s, status, result);
            }
            catch { }
        }
    }

    static async Task Write(NetworkStream s, int status, object result)
    {
        var payload = result is JsonNode node ? Encoding.UTF8.GetBytes(node.ToJsonString()) : JsonSerializer.SerializeToUtf8Bytes(result, result.GetType(), Json);
        var head = $"HTTP/1.1 {status} {(status == 200 ? "OK" : "Error")}\r\nContent-Type: application/json\r\nContent-Length: {payload.Length}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n";
        await s.WriteAsync(Encoding.ASCII.GetBytes(head));
        await s.WriteAsync(payload);
        await s.FlushAsync();
    }
}
