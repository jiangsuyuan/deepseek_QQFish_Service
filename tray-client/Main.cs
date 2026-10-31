using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Text;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;

namespace FishTray
{
    public class Settings
    {
        public string base_url { get; set; }
        public string token { get; set; }
        public string sshKey { get; set; }
        public string sshHost { get; set; }
        public int port { get; set; }
        public string theme { get; set; }

        public Settings()
        {
            base_url = "http://127.0.0.1:3081";
            token = "";
            sshKey = "";
            sshHost = "";
            port = 3081;
            theme = "dark";
        }

        public static string Dir
        {
            get
            {
                string d = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "fish-tray");
                try { Directory.CreateDirectory(d); } catch { }
                return d;
            }
        }

        static string CfgFile { get { return Path.Combine(Dir, "settings.json"); } }

        public static Settings Load()
        {
            try
            {
                if (File.Exists(CfgFile))
                {
                    var s = new JavaScriptSerializer().Deserialize<Settings>(File.ReadAllText(CfgFile, Encoding.UTF8));
                    if (s != null)
                    {
                        if (s.port == 0) s.port = 3081;
                        if (string.IsNullOrEmpty(s.base_url)) s.base_url = "http://127.0.0.1:3081";
                        if (string.IsNullOrEmpty(s.theme)) s.theme = "dark";
                        return s;
                    }
                }
            }
            catch { }
            return new Settings();
        }

        public void Save()
        {
            try { File.WriteAllText(CfgFile, new JavaScriptSerializer().Serialize(this), Encoding.UTF8); }
            catch { }
        }
    }

    public class Palette
    {
        public Color Bg, Fg, Muted, Line, Card, MeBg, MeFg, HerBg, HerFg, InputBg;

        public static Palette Dark()
        {
            return new Palette
            {
                Bg = Color.FromArgb(15, 17, 21), Fg = Color.FromArgb(230, 230, 230),
                Muted = Color.FromArgb(139, 147, 161), Line = Color.FromArgb(35, 38, 45),
                Card = Color.FromArgb(26, 29, 36), MeBg = Color.FromArgb(41, 88, 158), MeFg = Color.FromArgb(240, 245, 255),
                HerBg = Color.FromArgb(44, 50, 62), HerFg = Color.FromArgb(230, 232, 238),
                InputBg = Color.FromArgb(26, 29, 36)
            };
        }

        public static Palette Light()
        {
            return new Palette
            {
                Bg = Color.FromArgb(246, 247, 249), Fg = Color.FromArgb(31, 35, 40),
                Muted = Color.FromArgb(107, 114, 128), Line = Color.FromArgb(227, 230, 234),
                Card = Color.White, MeBg = Color.FromArgb(47, 100, 190), MeFg = Color.White,
                HerBg = Color.FromArgb(240, 242, 246), HerFg = Color.FromArgb(31, 35, 40),
                InputBg = Color.White
            };
        }
    }

    public static class Log
    {
        static readonly object Lk = new object();

        /// <summary>日志写在 exe 同目录，避免 %APPDATA% 被安全软件拦</summary>
        static string LogFile
        {
            get
            {
                try { return Path.Combine(Application.StartupPath, "run.log"); }
                catch { return Path.Combine(Path.GetTempPath(), "fish-tray-run.log"); }
            }
        }

        public static void W(string m)
        {
            try
            {
                lock (Lk)
                {
                    string f = LogFile;
                    if (File.Exists(f) && new FileInfo(f).Length > 200 * 1024) File.Delete(f);
                    File.AppendAllText(f, DateTime.Now.ToString("HH:mm:ss") + " " + m + "\r\n", Encoding.UTF8);
                }
            }
            catch { }
        }
    }

    public static class Tunnel
    {
        static string PidFile { get { return Path.Combine(Settings.Dir, "tunnel.pid"); } }

        public static bool Open(int port)
        {
            try
            {
                using (var c = new System.Net.Sockets.TcpClient())
                {
                    var ar = c.BeginConnect("127.0.0.1", port, null, null);
                    if (!ar.AsyncWaitHandle.WaitOne(500)) return false;
                    c.EndConnect(ar);
                    return true;
                }
            }
            catch { return false; }
        }

        static void KillMine()
        {
            try
            {
                if (!File.Exists(PidFile)) return;
                int pid;
                if (int.TryParse(File.ReadAllText(PidFile).Trim(), out pid))
                {
                    var p = Process.GetProcessById(pid);
                    if (p != null && p.ProcessName.ToLower().Contains("ssh")) { p.Kill(); Log.W("结束隧道 " + pid); }
                }
                File.Delete(PidFile);
            }
            catch { }
        }

        public static string Ensure(Settings s)
        {
            if (Open(s.port)) return "已连接";
            if (string.IsNullOrEmpty(s.sshKey) || string.IsNullOrEmpty(s.sshHost)) return "未配置 SSH";

            KillMine();

            try
            {
                var psi = new ProcessStartInfo("ssh")
                {
                    CreateNoWindow = true,
                    UseShellExecute = false
                };
                psi.Arguments = "-i \"" + s.sshKey + "\" -o StrictHostKeyChecking=no " +
                    "-o UserKnownHostsFile=NUL -o ServerAliveInterval=20 " +
                    "-o ServerAliveCountMax=2 -o ExitOnForwardFailure=yes -N -L " +
                    s.port + ":127.0.0.1:" + s.port + " " + s.sshHost;
                var pr = Process.Start(psi);
                if (pr != null) { try { File.WriteAllText(PidFile, pr.Id.ToString()); } catch { } }
            }
            catch (Exception ex) { Log.W("ssh 失败 " + ex.Message); return "ssh 启动失败"; }

            for (int i = 0; i < 12; i++)
            {
                System.Threading.Thread.Sleep(1000);
                if (Open(s.port)) return "已连接";
            }
            return "隧道未通";
        }

        public static void Shutdown() { KillMine(); }
    }

    public static class Api
    {
        public static readonly HttpClient Http = Make();
        static readonly HttpClient H = Http;

        static HttpClient Make()
        {
            try
            {
                ServicePointManager.SecurityProtocol =
                    SecurityProtocolType.Tls12 | SecurityProtocolType.Tls11 | SecurityProtocolType.Tls;
                ServicePointManager.ServerCertificateValidationCallback = delegate { return true; };
            }
            catch { }
            var c = new HttpClient();
            c.Timeout = TimeSpan.FromSeconds(20);
            return c;
        }

        static string Url(Settings s, string p)
        {
            string sep = p.IndexOf('?') >= 0 ? "&" : "?";
            return s.base_url.TrimEnd('/') + p + sep + "token=" + Uri.EscapeDataString(s.token);
        }

        public static string Get(Settings s, string p)
        {
            try { return H.GetAsync(Url(s, p)).GetAwaiter().GetResult().Content.ReadAsStringAsync().GetAwaiter().GetResult(); }
            catch (Exception ex) { return "__ERR__" + ex.Message; }
        }

        public static bool Send(Settings s, string text)
        {
            try
            {
                string json = new JavaScriptSerializer().Serialize(
                    new Dictionary<string, object> { { "text", text }, { "from", "" } });
                var c = new StringContent(json, Encoding.UTF8, "application/json");
                return H.PostAsync(Url(s, "/send"), c).GetAwaiter().GetResult().IsSuccessStatusCode;
            }
            catch { return false; }
        }
    }

    public class Msg
    {
        public string role { get; set; }
        public string text { get; set; }
        public string image { get; set; }
        public string tool { get; set; }
        public long at { get; set; }
    }

    public class Bubble : Control
    {
        public string Role = "her";
        public string Body = "";
        public Image Pic;              // 有图就画图，不画文字气泡
        public Color BgCol, FgCol;
        public int Radius = 10;
        public int PadX = 11;
        public int PadY = 7;

        static readonly Font BodyFont = new Font("Microsoft YaHei UI", 9.5f);
        static readonly Font ToolFont = new Font("Microsoft YaHei UI", 8f);

        static readonly Dictionary<string, string> Zh = new Dictionary<string, string>
        {
            {"send_sticker","发表情"},{"list_stickers","看表情库"},{"save_sticker","存表情"},
            {"send_face","发小黄脸"},{"at_person","艾特别人"},{"draw_image","画图"},{"draw_svg","画SVG"},
            {"web_search","搜网"},{"web_fetch","读网页"},{"hot_news","查热点"},{"recall","翻旧对话"},
            {"remember_fact","记事实"},{"remember_person","记人物"},{"remember_self","记想法"},
            {"revise_self","改想法"},{"forget_self","忘想法"},{"my_memory","查记忆"},
            {"memory_index","看记忆目录"},{"my_digest","看近期摘要"},{"person_dossier","查档案"},
            {"group_recap","看群记录"},{"who_said","查谁说的"},{"view_avatar","看头像"},
            {"my_status","看状态"},{"my_activities","看活动"},{"my_adventures","看探险"},
            {"my_capabilities","看能力"},{"my_changelog","看日志"},{"my_source","看源码"},
            {"my_outages","看掉线"},{"my_schedule","看排期"},{"exec_sandbox","跑代码"},
            {"read_source","读源码"},{"note_want","记需求"},{"my_wants","看需求"},
            {"resolve_want","标记完成"},{"drop_want","删需求"},{"request_feature","申请功能"},
            {"render_page","做网页"},{"add_webui_button","加按钮"},{"remove_webui_button","删按钮"},
            {"read_forward_more","展开转发"},{"refuse_person","拒聊"},{"owner_commands","查指令"},
            {"run_activity","开始活动"},{"set_reminder","设提醒"},{"group_impressions","群印象"},
            {"my_thoughts","看想法"},{"remember","记东西"}
        };

        static readonly Dictionary<string, string> KindMap = new Dictionary<string, string>
        {
            {"send_sticker","chat"},{"list_stickers","chat"},{"save_sticker","chat"},
            {"send_face","chat"},{"at_person","chat"},
            {"draw_image","draw"},{"draw_svg","draw"},{"render_page","draw"},
            {"my_memory","mem"},{"memory_index","mem"},{"my_digest","mem"},{"recall","mem"},
            {"remember_fact","mem"},{"remember_person","mem"},{"remember_self","mem"},
            {"revise_self","mem"},{"forget_self","mem"},{"person_dossier","mem"},
            {"group_recap","mem"},{"who_said","mem"},{"view_avatar","mem"},
            {"my_status","self"},{"my_activities","self"},{"my_adventures","self"},
            {"my_capabilities","self"},{"my_changelog","self"},{"my_source","self"},
            {"my_outages","self"},{"my_schedule","self"},{"owner_commands","self"},
            {"group_impressions","self"},{"my_thoughts","self"},
            {"exec_sandbox","code"},{"read_source","code"},
            {"note_want","want"},{"my_wants","want"},{"resolve_want","want"},
            {"drop_want","want"},{"request_feature","want"},
            {"web_search","net"},{"web_fetch","net"},{"hot_news","net"}
        };

        static readonly Dictionary<string, Color[]> Colors = new Dictionary<string, Color[]>
        {
            {"chat", new[]{Color.FromArgb(30,77,122), Color.FromArgb(166,219,255)}},
            {"mem",  new[]{Color.FromArgb(69,42,112), Color.FromArgb(216,188,255)}},
            {"self", new[]{Color.FromArgb(29,81,56),  Color.FromArgb(150,232,187)}},
            {"code", new[]{Color.FromArgb(92,57,23),  Color.FromArgb(255,211,154)}},
            {"want", new[]{Color.FromArgb(94,37,68),  Color.FromArgb(255,176,205)}},
            {"net",  new[]{Color.FromArgb(21,78,78),  Color.FromArgb(150,232,232)}},
            {"draw", new[]{Color.FromArgb(61,43,112), Color.FromArgb(201,180,255)}},
            {"other",new[]{Color.FromArgb(47,58,94),  Color.FromArgb(182,198,240)}}
        };

        static string Clean(string t)
        {
            t = (t ?? "").Trim();
            if (t.StartsWith("[")) t = t.Substring(1);
            if (t.EndsWith("]")) t = t.Substring(0, t.Length - 1);
            return t.Trim();
        }

        public static string ZhName(string tool)
        {
            string t = Clean(tool);
            if (Zh.ContainsKey(t)) return Zh[t];
            foreach (char c in t) if (c >= 0x4e00 && c <= 0x9fff) return t;
            return "某个操作";
        }

        public Bubble(string role, string body, Palette pal, int maxWidth)
        {
            Role = role;
            Body = body ?? "";

            // 普通 Control 默认不支持透明背景，必须先开这个样式
            SetStyle(ControlStyles.SupportsTransparentBackColor |
                     ControlStyles.AllPaintingInWmPaint |
                     ControlStyles.UserPaint |
                     ControlStyles.OptimizedDoubleBuffer, true);
            DoubleBuffered = true;
            BackColor = Color.Transparent;

            if (role == "tool")
            {
                string key = Clean(Body);
                string kind = KindMap.ContainsKey(key) ? KindMap[key] : "other";
                Color[] c = Colors[kind];
                BgCol = c[0]; FgCol = c[1];
                PadX = 8;
                PadY = 3;
                Size sz = TextRenderer.MeasureText(ZhName(Body), ToolFont);
                Size = new Size(sz.Width + PadX * 2, ToolFont.Height + PadY * 2);
                Radius = 8;
            }
            else
            {
                BgCol = role == "me" ? pal.MeBg : pal.HerBg;
                FgCol = role == "me" ? pal.MeFg : pal.HerFg;
                int wrap = Math.Max(90, maxWidth - PadX * 2);
                Size sz = TextRenderer.MeasureText(Body, BodyFont, new Size(wrap, int.MaxValue),
                    TextFormatFlags.WordBreak | TextFormatFlags.TextBoxControl);
                int w = Math.Min(wrap, Math.Max(26, sz.Width + 2));
                Size inner = TextRenderer.MeasureText(Body, BodyFont, new Size(w, int.MaxValue),
                    TextFormatFlags.WordBreak | TextFormatFlags.TextBoxControl);
                Size = new Size(w + PadX * 2, inner.Height + PadY * 2);
            }

            ApplyRegion();
        }

        /// <summary>换主题时重新套调色板（气泡颜色在构造时定死，必须重设）</summary>
        public void ApplyPalette(Palette p)
        {
            if (Parent != null) BackColor = Parent.BackColor;
            if (Role == "tool") { Invalidate(); return; }
            BgCol = Role == "me" ? p.MeBg : p.HerBg;
            FgCol = Role == "me" ? p.MeFg : p.HerFg;
            Invalidate();
        }

        /// <summary>不再用 Region 裁（那是二值掩码，圆角必然锯齿）。
        /// 改成把控件底色刷成父容器颜色，再由 OnPaint 抗锯齿画圆角。</summary>
        void ApplyRegion()
        {
            try
            {
                Region = null;
                if (Parent != null) BackColor = Parent.BackColor;
            }
            catch { }
        }

        protected override void OnResize(EventArgs e)
        {
            base.OnResize(e);
            ApplyRegion();
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            var g = e.Graphics;
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.PixelOffsetMode = PixelOffsetMode.HighQuality;
            g.Clear(Parent != null ? Parent.BackColor : BackColor);

            if (Pic != null)
            {
                // 图片消息：按圆角裁剪后直接铺图
                using (var path = Round(ClientRectangle, Radius))
                {
                    var old = g.Clip;
                    g.SetClip(path);
                    g.InterpolationMode = InterpolationMode.HighQualityBicubic;
                    g.DrawImage(Pic, ClientRectangle);
                    g.Clip = old;
                }
                return;
            }

            using (var path = Round(ClientRectangle, Radius))
            using (var b = new SolidBrush(BgCol))
                g.FillPath(b, path);

            string txt = Role == "tool" ? ZhName(Body) : Body;
            var rect = new Rectangle(PadX, PadY - 1, Width - PadX * 2, Height - PadY * 2 + 2);
            TextRenderer.DrawText(g, txt, Role == "tool" ? ToolFont : BodyFont, rect, FgCol,
                TextFormatFlags.WordBreak | TextFormatFlags.NoPadding | TextFormatFlags.TextBoxControl);
        }


        /// <summary>复制成功后通知外面（标题栏闪一下"已复制"）</summary>
        public event Action<string> Copied;

        // 菜单只建一次，每次右键复用（之前每次 new，旧的不释放会叠在一起）
        ContextMenuStrip _menu;
        ToolStripMenuItem _miCopy;
        ToolStripMenuItem _miPic;

        void BuildMenu()
        {
            _menu = new ContextMenuStrip();
            _menu.ShowImageMargin = false;

            _miCopy = new ToolStripMenuItem("复制这条");
            _miCopy.Click += delegate
            {
                if (string.IsNullOrEmpty(Body)) return;
                try
                {
                    Clipboard.SetText(Body);
                    if (Copied != null) Copied(Body);
                }
                catch { }
            };
            _menu.Items.Add(_miCopy);

            _miPic = new ToolStripMenuItem("复制图片");
            _miPic.Click += delegate
            {
                if (Pic == null) return;
                try { Clipboard.SetImage(Pic); if (Copied != null) Copied(""); }
                catch { }
            };
            _menu.Items.Add(_miPic);

            _menu.Opening += delegate
            {
                _miCopy.Enabled = !string.IsNullOrEmpty(Body);
                _miPic.Visible = Pic != null;
            };

            // 关键：挂到属性上，WinForms 自己处理右键，不再冒泡到父容器
            ContextMenuStrip = _menu;
        }

        protected override void OnMouseDown(MouseEventArgs e)
        {
            // 右键交给 ContextMenuStrip 属性处理（见 BuildMenu），
            // 自己 Show 会和父容器的菜单撞在一起，出现两个
            base.OnMouseDown(e);
            if (e.Button == MouseButtons.Right && _menu == null) BuildMenu();
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing && _menu != null) { _menu.Dispose(); _menu = null; }
            base.Dispose(disposing);
        }

        static GraphicsPath Round(Rectangle r, int rad)
        {
            var p = new GraphicsPath();
            int d = rad * 2;
            if (r.Width < d + 2 || r.Height < d + 2) { p.AddRectangle(r); return p; }
            p.AddArc(r.X, r.Y, d, d, 180, 90);
            p.AddArc(r.Right - d - 1, r.Y, d, d, 270, 90);
            p.AddArc(r.Right - d - 1, r.Bottom - d - 1, d, d, 0, 90);
            p.AddArc(r.X, r.Bottom - d - 1, d, d, 90, 90);
            p.CloseFigure();
            return p;
        }
    }

    /// <summary>自绘图标按钮（叉 / 月亮 / 太阳），不靠字体，保证两个按钮一样大一样齐</summary>
    public class IconBtn : Button
    {
        public string Kind = "close";
        public Color Ink = Color.Gray;

        public IconBtn()
        {
            FlatStyle = FlatStyle.Flat;
            FlatAppearance.BorderSize = 0;
            SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint |
                     ControlStyles.OptimizedDoubleBuffer | ControlStyles.SupportsTransparentBackColor, true);
            BackColor = Color.Transparent;
            Cursor = Cursors.Hand;
            TabStop = false;
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            var g = e.Graphics;
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.Clear(Parent != null ? Parent.BackColor : Color.Transparent);

            float w = Width, h = Height;

            if (Kind == "close")
            {
                using (var pen = new Pen(Ink, 1.7f))
                {
                    pen.StartCap = LineCap.Round;
                    pen.EndCap = LineCap.Round;
                    g.DrawLine(pen, w * 0.32f, h * 0.30f, w * 0.68f, h * 0.70f);
                    g.DrawLine(pen, w * 0.68f, h * 0.30f, w * 0.32f, h * 0.70f);
                }
            }
            else if (Kind == "moon")
            {
                // 月牙 = 椭圆 减去 另一个偏右上的椭圆
                // 注意：Region(RectangleF) 是矩形区域，不是椭圆，必须用 GraphicsPath.AddEllipse
                var bigPath = new GraphicsPath();
                bigPath.AddEllipse(w * 0.14f, h * 0.14f, w * 0.72f, h * 0.72f);
                var cutPath = new GraphicsPath();
                cutPath.AddEllipse(w * 0.46f, h * 0.06f, w * 0.70f, h * 0.72f);

                using (var big = new Region(bigPath))
                using (var cut = new Region(cutPath))
                using (var b = new SolidBrush(Ink))
                {
                    big.Exclude(cut);
                    g.FillRegion(b, big);
                }
                bigPath.Dispose();
                cutPath.Dispose();
            }
            else // sun
            {
                using (var pen = new Pen(Ink, 1.6f))
                {
                    pen.StartCap = LineCap.Round;
                    pen.EndCap = LineCap.Round;
                    g.DrawEllipse(pen, w * 0.34f, h * 0.32f, w * 0.32f, h * 0.36f);
                    for (int i = 0; i < 8; i++)
                    {
                        double a = Math.PI * 2 * i / 8;
                        float cx = w * 0.5f, cy = h * 0.5f;
                        float r1 = w * 0.26f, r2 = w * 0.36f;
                        g.DrawLine(pen,
                            cx + (float)Math.Cos(a) * r1, cy + (float)Math.Sin(a) * r1,
                            cx + (float)Math.Cos(a) * r2, cy + (float)Math.Sin(a) * r2);
                    }
                }
            }
        }
    }

    /// <summary>圆角路径工具（窗体 / 按钮 / 输入框宿主共用）</summary>
    public static class R
    {
        public static GraphicsPath Path(Rectangle r, int rad)
        {
            var p = new GraphicsPath();
            int d = rad * 2;
            if (r.Width < d + 2 || r.Height < d + 2) { p.AddRectangle(r); return p; }
            p.AddArc(r.X, r.Y, d, d, 180, 90);
            p.AddArc(r.Right - d - 1, r.Y, d, d, 270, 90);
            p.AddArc(r.Right - d - 1, r.Bottom - d - 1, d, d, 0, 90);
            p.AddArc(r.X, r.Bottom - d - 1, d, d, 90, 90);
            p.CloseFigure();
            return p;
        }

        public static void Round(Control c, int rad)
        {
            try
            {
                if (c == null || c.Width < 4 || c.Height < 4) return;
                using (var p = Path(c.ClientRectangle, rad))
                    c.Region = new Region(p);
            }
            catch { }
        }
    }

    public class ChatForm : Form
    {
        Settings cfg;
        Palette pal;
        bool light;

        Panel header, footer, scrollHost, canvas;
        Label dot, titleLabel, statusLabel;
        PictureBox fishPic;
        Button reconnectBtn;
        IconBtn themeBtn, closeBtn;
        TextBox input;
        Panel inputHost;
        PictureBox fishStrip;     // 收起时显示的鱼图标条
        Button sendBtn;

        [System.Runtime.InteropServices.DllImport("dwmapi.dll")]
        static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int val, int size);

        /// <summary>让 Win11 自己给窗口做圆角（系统级抗锯齿，比自己 Region 裁干净得多）</summary>
        void UseSystemRoundCorner()
        {
            try
            {
                int pref = 2;   // DWMWCP_ROUND
                int r = DwmSetWindowAttribute(Handle, 33 /*DWMWA_WINDOW_CORNER_PREFERENCE*/, ref pref, sizeof(int));
                Log.W("DWM 圆角: " + (r == 0 ? "成功" : "hr=" + r));
            }
            catch (Exception ex) { Log.W("DWM 圆角失败 " + ex.Message); }
        }

        [System.Runtime.InteropServices.DllImport("user32.dll")]
        static extern bool ReleaseCapture();

        [System.Runtime.InteropServices.DllImport("user32.dll")]
        static extern IntPtr SendMessage(IntPtr hWnd, int msg, int wParam, int lParam);

        Timer pollTimer;
        long lastAt = 0;
        int fails = 0;
        bool sending = false;
        bool reallyExit = false;
        readonly List<Bubble> bubbles = new List<Bubble>();
        // 刚本地显示过的那句话，轮询回来时跳过，避免双份
        string pendingMe = "";
        long pendingAt = 0;

        public ChatForm()
        {
            cfg = Settings.Load();
            light = cfg.theme == "light";
            pal = light ? Palette.Light() : Palette.Dark();
            Build();
            ApplyPal();
            Shown += OnShown;
            FormClosing += OnClosing;
            Resize += delegate { Relayout(); RoundEverything(); };
            MouseDown += OnFormMouseDown;
            MouseMove += OnFormMouseMove;
            MouseUp += OnFormMouseUp;
        }

        void Build()
        {
            Text = "竹筒肥鱼";
            StartPosition = FormStartPosition.Manual;
            FormBorderStyle = FormBorderStyle.None;   // 自绘标题栏，不用系统那套
            Size = new Size(400, 800);
            MinimumSize = new Size(380, 600);
            ShowInTaskbar = false;
            TopMost = true;
            DoubleBuffered = true;
            Padding = new Padding(1);                 // 给自绘边框留 1px
            Icon = MakeFishIcon(32);

            header = new Panel { Dock = DockStyle.Top, Height = 42, Cursor = Cursors.SizeAll };
            header.Paint += delegate (object s, PaintEventArgs e)
            { using (var p = new Pen(pal.Line)) e.Graphics.DrawLine(p, 0, 41, header.Width, 41); };
            header.MouseDown += delegate (object s, MouseEventArgs e)
            {
                if (e.Button == MouseButtons.Left)
                {
                    ReleaseCapture();
                    SendMessage(Handle, 0xA1, 0x2, 0);   // WM_NCLBUTTONDOWN / HTCAPTION
                }
            };

            fishPic = new PictureBox
            {
                Size = new Size(24, 24),
                SizeMode = PictureBoxSizeMode.Zoom,
                BackColor = Color.Transparent,
                Location = new Point(10, 9)
            };
            try
            {
                // 直接用 Bitmap 画，不绕 Icon.ToBitmap（那个有时会拿到全透明的图）
                fishPic.Image = MakeFishBitmap(48);
                fishPic.SizeMode = PictureBoxSizeMode.StretchImage;
                using (var gp = R.Path(new Rectangle(0, 0, fishPic.Width - 1, fishPic.Height - 1), 7))
                    fishPic.Region = new Region(gp);
                Log.W("鱼图标已设置 image=" + (fishPic.Image != null) + " size=" + fishPic.Width + "x" + fishPic.Height);
            }
            catch (Exception ex) { Log.W("鱼图标失败 " + ex.Message); }

            dot = new Label { Text = "", AutoSize = false, Size = new Size(1, 1), Location = new Point(34, 20), Font = new Font("Microsoft YaHei UI", 9f) };
            titleLabel = new Label { Text = "竹筒肥鱼", AutoSize = true, Location = new Point(38, 12), Font = new Font("Microsoft YaHei UI", 10f, FontStyle.Bold) };
            header.Controls.Add(fishPic);
            statusLabel = new Label { Text = "", AutoSize = true, Location = new Point(108, 14), Font = new Font("Microsoft YaHei UI", 8f) };

            reconnectBtn = new Button
            {
                Text = "重连",
                FlatStyle = FlatStyle.Flat,
                Font = new Font("Microsoft YaHei UI", 8.5f),
                Size = new Size(48, 24),
                Cursor = Cursors.Hand, TextAlign = ContentAlignment.MiddleCenter, Padding = new Padding(0)
            };
            reconnectBtn.FlatAppearance.BorderSize = 0;
            reconnectBtn.Click += delegate { Reconnect(); };

            themeBtn = new IconBtn
            {
                Kind = light ? "sun" : "moon",
                Size = new Size(26, 26)
            };
            themeBtn.Click += delegate { ToggleTheme(); };

            closeBtn = new IconBtn
            {
                Kind = "close",
                Size = new Size(26, 26)
            };
            closeBtn.Click += delegate { Collapse(); }; // 缩成贴边的一条

            header.Controls.Add(dot);
            header.Controls.Add(titleLabel);
            header.Controls.Add(statusLabel);
            header.Controls.Add(reconnectBtn);
            header.Controls.Add(themeBtn);
            header.Controls.Add(closeBtn);
            header.Resize += delegate { LayoutHeader(); };

            footer = new Panel { Dock = DockStyle.Bottom, Height = 58 };
            footer.Paint += delegate (object s, PaintEventArgs e)
            { using (var p = new Pen(pal.Line)) e.Graphics.DrawLine(p, 0, 0, footer.Width, 0); };

            inputHost = new Panel { BackColor = pal.InputBg };
            inputHost.Paint += delegate (object s2, PaintEventArgs e2)
            {
                e2.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
                using (var p = R.Path(new Rectangle(0, 0, inputHost.Width - 1, inputHost.Height - 1), 8))
                using (var pen = new Pen(pal.Line, 1f))
                    e2.Graphics.DrawPath(pen, p);
            };

            input = new TextBox
            {
                Multiline = true,
                Font = new Font("Microsoft YaHei UI", 9.5f),
                BorderStyle = BorderStyle.None,      // 边框由宿主画
                ScrollBars = ScrollBars.None,
                BackColor = pal.InputBg,
                ForeColor = pal.Fg
            };
            input.KeyDown += OnInputKey;
            inputHost.Controls.Add(input);

            sendBtn = new Button { Text = "发送", FlatStyle = FlatStyle.Flat, Font = new Font("Microsoft YaHei UI", 9.5f) };
            sendBtn.FlatAppearance.BorderSize = 0;
            sendBtn.Click += delegate { SendNow(); };

            footer.Controls.Add(inputHost);
            footer.Controls.Add(sendBtn);
            footer.Resize += delegate { LayoutFooter(); };

            scrollHost = new Panel { Dock = DockStyle.Fill, AutoScroll = false };
            canvas = new Panel { Location = new Point(0, 0) };
            canvas.ContextMenuStrip = new ContextMenuStrip();
            var allMenu = canvas.ContextMenuStrip;
            allMenu.Items.Add("复制全部聊天", null, delegate { CopyAll(); });
            allMenu.Items.Add("清空显示", null, delegate
            {
                canvas.Controls.Clear();
                bubbles.Clear();
                lastAt = 0;
                Log.W("已清空显示");
            });

            scrollHost.Controls.Add(canvas);
            scrollHost.Resize += delegate { Relayout(); };
            scrollHost.MouseWheel += delegate (object s2, MouseEventArgs e2) { Wheel(e2.Delta); };
            canvas.MouseWheel += delegate (object s2, MouseEventArgs e2) { Wheel(e2.Delta); };

            fishStrip = new PictureBox
            {
                Dock = DockStyle.Fill,
                SizeMode = PictureBoxSizeMode.StretchImage,
                BackColor = pal.Card,
                Visible = false
            };
            try { fishStrip.Image = MakeFishBitmap(96); } catch { }
            fishStrip.MouseDown += delegate (object s2, MouseEventArgs e2) { OnFormMouseDown(s2, e2); };
            fishStrip.MouseMove += delegate (object s2, MouseEventArgs e2) { OnFormMouseMove(s2, e2); };
            fishStrip.MouseUp += delegate (object s2, MouseEventArgs e2) { OnFormMouseUp(s2, e2); };
            fishStrip.Cursor = Cursors.Hand;

            Controls.Add(fishStrip);
            Controls.Add(scrollHost);
            Controls.Add(footer);
            Controls.Add(header);

            // 不依赖系统托盘（未签名程序在 Win11 上图标显示不出来），改成贴右边常驻
            ContextMenuStrip = new ContextMenuStrip();
            ContextMenuStrip.Items.Add("展开", null, delegate { Expand(); });
            ContextMenuStrip.Items.Add("收起", null, delegate { Collapse(); });
            ContextMenuStrip.Items.Add(new ToolStripSeparator());
            ContextMenuStrip.Items.Add("重连隧道", null, delegate { Reconnect(); });
            ContextMenuStrip.Items.Add("退出", null, delegate { reallyExit = true; Close(); });
        }

        // ─── 贴边常驻 ───

        const int EXPANDED_W = 400;
        const int COLLAPSED_W = 56;
        const int COLLAPSED_H = 56;
        bool collapsed = false;
        Timer collapseTimer;

        /// <summary>把窗口位置夹到屏幕工作区内，不超出边界</summary>
        static Point ClampToScreen(int x, int y, int w, int h, Rectangle wa)
        {
            if (w > wa.Width) w = wa.Width;
            if (h > wa.Height) h = wa.Height;
            if (x + w > wa.Right) x = wa.Right - w;
            if (y + h > wa.Bottom) y = wa.Bottom - h;
            if (x < wa.Left) x = wa.Left;
            if (y < wa.Top) y = wa.Top;
            return new Point(x, y);
        }

        // 收起后的位置（用户拖过就记这里，下次收起别再归位到默认点）
        Point collapsedPos = Point.Empty;
        bool hasCollapsedPos = false;

        void Collapse()
        {
            if (collapsed) return;

            // 注意：收起时**不重算**图标位置。
            // 之前这里是「把图标挪到窗口右边缘」，结果每次展开再收起，
            // 图标都会跟着窗口走一段，不再是用户拖到的那个点。
            collapsed = true;

            var wa = Screen.PrimaryScreen.WorkingArea;
            SuspendLayout();
            MinimumSize = Size.Empty;          // 关键：不然会被 380x600 拦住
            header.Visible = false;
            footer.Visible = false;
            scrollHost.Visible = false;
            fishStrip.BackColor = pal.Card;
            fishStrip.Visible = true;
            fishStrip.BringToFront();
            Width = COLLAPSED_W;
            Height = COLLAPSED_H;
            if (hasCollapsedPos)
            {
                var cp = ClampToScreen(collapsedPos.X, collapsedPos.Y, COLLAPSED_W, COLLAPSED_H, wa);
                Left = cp.X;
                Top = cp.Y;
            }
            else
            {
                Left = wa.Right - COLLAPSED_W - 8;
                Top = wa.Top + (wa.Height - COLLAPSED_H) / 2;
            }
            ResumeLayout();
            BackColor = pal.Card;

            // 裁成圆角方块（不是正圆）
            try
            {
                using (var p = R.Path(ClientRectangle, 11))
                    Region = new Region(p);
            }
            catch { }
            Invalidate();
            Log.W("已收起");
        }

        void Expand()
        {
            if (!collapsed) { ShowIt(); return; }
            collapsed = false;

            var wa = Screen.PrimaryScreen.WorkingArea;
            SuspendLayout();
            MinimumSize = new Size(380, 600);
            fishStrip.Visible = false;
            HeaderShow();
            Region = null;
            Width = EXPANDED_W;
            // 高度不能超过屏幕：原来硬编码 800，小屏会伸出边界
            Height = Math.Min(800, wa.Height - 40);

            // 以图标（收起态）位置为基准展开
            int iconRight, iconCenterY;
            if (hasCollapsedPos)
            {
                iconRight = collapsedPos.X + COLLAPSED_W;
                iconCenterY = collapsedPos.Y + COLLAPSED_H / 2;
            }
            else
            {
                iconRight = wa.Right - 8;
                iconCenterY = wa.Top + wa.Height / 2;
            }

            int tx2 = iconRight - Width;
            int ty2 = iconCenterY - 40;
            var pos = ClampToScreen(tx2, ty2, Width, Height, wa);
            Left = pos.X;
            Top = pos.Y;
            ResumeLayout();
            ApplyPal();
            Relayout();
            Log.W("已展开");
        }

        void HeaderShow()
        {
            header.Visible = true;
            footer.Visible = true;
            scrollHost.Visible = true;
        }

        // 收起状态下：点击展开，拖动移动位置（拖完不展开）
        bool collapsedDragging = false;
        Point dragStartPt;
        Point dragFormPt;

        void OnFormMouseDown(object sender, MouseEventArgs e)
        {
            if (!collapsed || e.Button != MouseButtons.Left) return;
            collapsedDragging = false;
            dragStartPt = Cursor.Position;
            dragFormPt = Location;
        }

        void OnFormMouseMove(object sender, MouseEventArgs e)
        {
            if (!collapsed || e.Button != MouseButtons.Left) return;
            Point now = Cursor.Position;
            if (!collapsedDragging &&
                (Math.Abs(now.X - dragStartPt.X) > 4 || Math.Abs(now.Y - dragStartPt.Y) > 4))
                collapsedDragging = true;

            if (collapsedDragging)
                Location = new Point(dragFormPt.X + (now.X - dragStartPt.X),
                                     dragFormPt.Y + (now.Y - dragStartPt.Y));
        }

        void OnFormMouseUp(object sender, MouseEventArgs e)
        {
            if (!collapsed || e.Button != MouseButtons.Left) return;
            if (!collapsedDragging)
            {
                Expand();   // 没拖动过 = 点击 = 展开
            }
            else
            {
                // 拖完了：记住位置，下次收起别再归位
                var wa2 = Screen.FromControl(this).WorkingArea;
                var p2 = ClampToScreen(Location.X, Location.Y, COLLAPSED_W, COLLAPSED_H, wa2);
                collapsedPos = p2;
                hasCollapsedPos = true;
                Location = p2;
                Log.W("图标位置已记住: " + p2.X + "," + p2.Y);
            }
            collapsedDragging = false;
        }

        [System.Runtime.InteropServices.DllImport("user32.dll", CharSet = System.Runtime.InteropServices.CharSet.Auto)]
        extern static bool DestroyIcon(IntPtr handle);

        static Image _fishImg;

        /// <summary>取嵌入的鱼图（fish.jpg），失败时退回内画的圆</summary>
        public static Image FishImage()
        {
            if (_fishImg != null) return _fishImg;
            try
            {
                var asm = typeof(ChatForm).Assembly;
                using (var st = asm.GetManifestResourceStream("FishTray.fish.jpg"))
                {
                    if (st != null)
                    {
                        _fishImg = Image.FromStream(st);
                        Log.W("鱼图来源：嵌入资源 " + _fishImg.Width + "x" + _fishImg.Height);
                    }
                    else Log.W("鱼图来源：资源没找到，回退画圆");
                }
            }
            catch { }
            if (_fishImg == null) _fishImg = DrawFallbackFish(200);
            return _fishImg;
        }

        static Bitmap DrawFallbackFish(int size)
        {
            var bmp = new Bitmap(size, size);
            using (var g = Graphics.FromImage(bmp))
            {
                g.SmoothingMode = SmoothingMode.AntiAlias;
                g.Clear(Color.Transparent);
                Color blue = Color.FromArgb(37, 99, 235);
                using (var b = new SolidBrush(blue)) g.FillEllipse(b, 0, 0, size - 1, size - 1);
                float bw = size * 0.54f, bh = size * 0.30f;
                float bx = size * 0.13f, by = (size - bh) / 2f;
                using (var w = new SolidBrush(Color.White)) g.FillEllipse(w, bx, by, bw, bh);
                float es = Math.Max(2f, size * 0.10f);
                using (var b = new SolidBrush(blue))
                    g.FillEllipse(b, bx + bw * 0.24f, by + bh * 0.34f, es, es);
            }
            return bmp;
        }

        /// <summary>把鱼图缩放到指定大小的方图（等比裁切铺满）</summary>
        public static Bitmap MakeFishBitmap(int size)
        {
            var src = FishImage();
            var bmp = new Bitmap(size, size);
            using (var g = Graphics.FromImage(bmp))
            {
                g.InterpolationMode = InterpolationMode.HighQualityBicubic;
                g.PixelOffsetMode = PixelOffsetMode.HighQuality;

                int s = Math.Min(src.Width, src.Height);
                var rect = new Rectangle((src.Width - s) / 2, (src.Height - s) / 2, s, s);
                g.DrawImage(src, new Rectangle(0, 0, size, size), rect, GraphicsUnit.Pixel);
            }
            return bmp;
        }

        public static Icon MakeFishIcon(int size)
        {
            // 注意：bmp 不能在 using 里被 Dispose —— GetHicon 得到的句柄依赖它。
            // 先 Clone 出独立的 Icon，再销毁原始句柄。
            var bmp = new Bitmap(size, size);
            try
            {
                using (var g = Graphics.FromImage(bmp))
                {
                    g.SmoothingMode = SmoothingMode.AntiAlias;
                    g.Clear(Color.Transparent);
                    Color blue = Color.FromArgb(37, 99, 235);
                    using (var b = new SolidBrush(blue)) g.FillEllipse(b, 0, 0, size - 1, size - 1);

                    float bw = size * 0.54f, bh = size * 0.30f;
                    float bx = size * 0.13f, by = (size - bh) / 2f;
                    using (var w = new SolidBrush(Color.White)) g.FillEllipse(w, bx, by, bw, bh);

                    PointF[] tail = {
                        new PointF(bx + bw - 1f, by + bh * 0.34f),
                        new PointF(size - 1f, by - bh * 0.10f),
                        new PointF(size - 1f, by + bh + bh * 0.10f),
                        new PointF(bx + bw - 1f, by + bh * 0.66f)
                    };
                    using (var w = new SolidBrush(Color.White)) g.FillPolygon(w, tail);

                    float es = Math.Max(2f, size * 0.10f);
                    using (var b = new SolidBrush(blue))
                        g.FillEllipse(b, bx + bw * 0.24f, by + bh * 0.34f, es, es);
                }

                IntPtr h = bmp.GetHicon();
                try
                {
                    using (var tmp = Icon.FromHandle(h))
                        return (Icon)tmp.Clone();
                }
                finally
                {
                    DestroyIcon(h);
                }
            }
            catch
            {
                return SystemIcons.Application;
            }
            finally
            {
                bmp.Dispose();
            }
        }

        /// <summary>把窗体、按钮、输入框的四角都切圆</summary>
        void RoundEverything()
        {
            try
            {
                if (collapsed && Width > 8 && Height > 8)
                {
                    // 收起的小方块只能靠 Region（DWM 不会给 56x56 做圆角）
                    using (var p = R.Path(ClientRectangle, 11))
                        Region = new Region(p);
                }
                else
                {
                    Region = null;      // 展开时交给 DWM 圆角
                }
            }
            catch { }
        }

        void LayoutHeader()
        {
            if (header == null || themeBtn == null) return;

            int cy = header.Height / 2;

            // 左边：鱼图标、标题、状态，统一按垂直居中
            fishPic.Location = new Point(10, cy - fishPic.Height / 2);
            titleLabel.Left = fishPic.Right + 6;
            titleLabel.Top = cy - titleLabel.Height / 2;
            statusLabel.Left = titleLabel.Right + 8;
            statusLabel.Top = cy - statusLabel.Height / 2;

            // 右边：三个按钮从右往左排，同样垂直居中
            int right = header.Width - 8;
            closeBtn.Size = new Size(26, 26);
            themeBtn.Size = new Size(26, 26);
            closeBtn.Location = new Point(right - closeBtn.Width, cy - closeBtn.Height / 2);
            themeBtn.Location = new Point(closeBtn.Left - themeBtn.Width - 4, cy - themeBtn.Height / 2);
            reconnectBtn.Location = new Point(themeBtn.Left - reconnectBtn.Width - 8, cy - reconnectBtn.Height / 2);
        }

        void LayoutFooter()
        {
            if (footer == null || inputHost == null) return;
            int h = footer.Height - 18;
            sendBtn.Size = new Size(62, h);
            sendBtn.Location = new Point(footer.Width - 72, 9);

            inputHost.Location = new Point(10, 9);
            inputHost.Size = new Size(footer.Width - 94, h);

            int ih = Math.Max(18, h - 14);
            input.Location = new Point(8, (h - ih) / 2 + 1);
            input.Size = new Size(inputHost.Width - 16, ih);

            // inputHost 也不裁 Region，靠它自己的 Paint 画圆角
        }

        void ApplyPal()
        {
            BackColor = pal.Bg;
            header.BackColor = pal.Bg;
            footer.BackColor = pal.Bg;
            scrollHost.BackColor = pal.Bg;
            canvas.BackColor = pal.Bg;
            titleLabel.ForeColor = pal.Fg;
            statusLabel.ForeColor = pal.Muted;
            dot.ForeColor = pal.Muted;
            input.BackColor = pal.InputBg;
            input.ForeColor = pal.Fg;
            if (inputHost != null) inputHost.BackColor = pal.InputBg;
            if (fishStrip != null) fishStrip.BackColor = pal.Card;
            sendBtn.BackColor = pal.MeBg;
            sendBtn.ForeColor = Color.White;
            foreach (var b in new Control[] { themeBtn, reconnectBtn, closeBtn })
            {
                b.BackColor = pal.Bg;
                b.ForeColor = pal.Muted;
            }
            themeBtn.Ink = pal.Muted;
            themeBtn.Kind = light ? "sun" : "moon";
            themeBtn.Invalidate();
            closeBtn.Ink = pal.Muted;
            closeBtn.Invalidate();
            LayoutHeader();
            LayoutFooter();
            Relayout();
            RoundEverything();
            Invalidate();
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            base.OnPaint(e);
            // 自绘 1px 边框，替掉系统的窗口边框
            using (var p = new Pen(pal.Line))
                e.Graphics.DrawRectangle(p, 0, 0, Width - 1, Height - 1);
        }

        void Relayout()
        {
            if (canvas == null || bubbles.Count == 0) return;
            int viewW = scrollHost.ClientSize.Width;
            if (viewW < 60) return;
            int w = viewW - 8;
            if (w < 100) return;

            int y = 10;
            canvas.SuspendLayout();
            canvas.Width = w;
            foreach (var b in bubbles)
            {
                b.Left = b.Role == "me" ? canvas.Width - b.Width - 10 : 10;
                if (b.Left < 0) b.Left = 0;
                b.Top = y;
                y += b.Height + 6;
            }
            canvas.Height = y + 14;
            canvas.ResumeLayout();
        }

        void CopyAll()
        {
            try
            {
                var sb = new StringBuilder();
                foreach (var b in bubbles)
                {
                    if (b.Pic != null) { sb.AppendLine("[图片]"); continue; }
                    if (string.IsNullOrEmpty(b.Body)) continue;
                    string who = b.Role == "me" ? "我" : (b.Role == "tool" ? "（工具）" : "她");
                    sb.AppendLine(who + "：" + b.Body);
                    sb.AppendLine();
                }
                Clipboard.SetText(sb.ToString());
                Log.W("已复制全部 " + sb.Length + " 字");
            }
            catch (Exception ex) { Log.W("复制失败 " + ex.Message); }
        }

        void ScrollEnd()
        {
            try
            {
                int maxOff = Math.Max(0, canvas.Height - scrollHost.ClientSize.Height);
                canvas.Top = -maxOff;
            }
            catch { }
        }

        void Wheel(int delta)
        {
            try
            {
                int maxOff = Math.Max(0, canvas.Height - scrollHost.ClientSize.Height);
                int next = canvas.Top + (delta > 0 ? 60 : -60);
                if (next > 0) next = 0;
                if (next < -maxOff) next = -maxOff;
                canvas.Top = next;
            }
            catch { }
        }

        void OnShown(object sender, EventArgs e)
        {
            Log.W("OnShown");
            UseSystemRoundCorner();
            var wa = Screen.PrimaryScreen.WorkingArea;
            Location = new Point(wa.Right - Width - 12, wa.Bottom - Height - 8);

            if (string.IsNullOrEmpty(cfg.token) || string.IsNullOrEmpty(cfg.sshHost))
            {
                using (var dlg = new SetupForm(cfg))
                {
                    if (dlg.ShowDialog(this) != DialogResult.OK) { reallyExit = true; Close(); return; }
                }
            }

            SetStatus("连接中…", false);
            Task.Run(delegate
            {
                string r = Tunnel.Ensure(cfg);
                try
                {
                    BeginInvoke((Action)delegate
                    {
                        SetStatus(r, Tunnel.Open(cfg.port));
                        Reload();
                        StartPoll();
                        Collapse();      // 启动后先缩成小图标，点一下才展开
                    });
                }
                catch { }
            });
        }

        void SetStatus(string t, bool ok)
        {
            try
            {
                if (InvokeRequired) { BeginInvoke((Action)delegate { SetStatus(t, ok); }); return; }
                statusLabel.Text = t;
                dot.ForeColor = ok ? Color.FromArgb(34, 197, 94) : pal.Muted;
            }
            catch { }
        }

        void StartPoll()
        {
            if (pollTimer != null) return;
            pollTimer = new Timer { Interval = 2000 };
            pollTimer.Tick += delegate { Poll(); };
            pollTimer.Start();
        }

        void Poll()
        {
            Task.Run(delegate
            {
                string body = Api.Get(cfg, "/history");
                try { BeginInvoke((Action)delegate { AfterPoll(body); }); } catch { }
            });
        }

        void AfterPoll(string body)
        {
            if (body != null && body.StartsWith("__ERR__"))
            {
                fails++;
                SetStatus("离线", false);
                if (fails >= 3)
                {
                    fails = 0;
                    SetStatus("重连中…", false);
                    Task.Run(delegate
                    {
                        string r = Tunnel.Ensure(cfg);
                        try { BeginInvoke((Action)delegate { SetStatus(r, Tunnel.Open(cfg.port)); }); } catch { }
                    });
                }
                return;
            }
            fails = 0;
            SetStatus("在线", true);
            Render(body, true);
        }

        void Reload()
        {
            Task.Run(delegate
            {
                string body = Api.Get(cfg, "/history");
                try { BeginInvoke((Action)delegate { Render(body, false); }); } catch { }
            });
        }

        void Render(string body, bool onlyNew)
        {
            if (body == null || body.StartsWith("__ERR__")) return;
            List<Msg> items;
            try { items = new JavaScriptSerializer().Deserialize<List<Msg>>(body); }
            catch { return; }
            if (items == null) return;

            int viewW = scrollHost.ClientSize.Width;
            int maxW = (int)(viewW * 0.78);
            if (maxW < 120) maxW = 240;

            if (!onlyNew)
            {
                canvas.SuspendLayout();
                canvas.Controls.Clear();
                bubbles.Clear();
                lastAt = 0;
                pendingMe = "";
                foreach (var m in items) { if (m.at > lastAt) lastAt = m.at; AddBubble(m, maxW); }
                canvas.ResumeLayout();
                Relayout();
                ScrollEnd();
                return;
            }

            bool added = false;
            canvas.SuspendLayout();
            foreach (var m in items)
            {
                if (m.at <= lastAt) continue;
                if (m.at > lastAt) lastAt = m.at;

                // 自己刚发的那条：本地已经画了，这里跳过
                if (!string.IsNullOrEmpty(pendingMe) && m.role == "me" &&
                    (m.text ?? "") == pendingMe && Math.Abs(m.at - pendingAt) < 20000)
                {
                    pendingMe = "";
                    continue;
                }

                AddBubble(m, maxW);
                added = true;
            }
            canvas.ResumeLayout();
            if (added) { Relayout(); ScrollEnd(); }
        }

        void AddBubble(Msg m, int maxW)
        {
            string role = m.role == "me" ? "me" : (m.role == "tool" ? "tool" : "her");

            // 图片消息：先放占位方块，图下载回来再填
            if (!string.IsNullOrEmpty(m.image))
            {
                AddImageBubble(m.image, role, maxW);
                return;
            }

            string body = m.text ?? "";
            var b = new Bubble(role, body, pal, maxW);
            b.Copied += delegate (string t) { FlashCopied(t); };
            b.Parent = canvas;
            bubbles.Add(b);
            canvas.Controls.Add(b);
        }

        void FlashCopied(string t)
        {
            try
            {
                string old = statusLabel.Text;
                SetStatus("已复制", true);
                var t2 = new Timer { Interval = 1200 };
                t2.Tick += delegate
                {
                    t2.Stop();
                    t2.Dispose();
                    SetStatus(old, Tunnel.Open(cfg.port));
                };
                t2.Start();
                Log.W("已复制 " + (t == null ? 0 : t.Length) + " 字");
            }
            catch { }
        }

        void AddImageBubble(string imgPath, string role, int maxW)
        {
            string url = imgPath;
            if (url.IndexOf("http", StringComparison.OrdinalIgnoreCase) != 0)
                url = cfg.base_url.TrimEnd('/') + url;

            var ph = new Bubble(role, "", pal, maxW);
            ph.Size = new Size(120, 120);
            ph.BgCol = pal.Card;
            ph.Parent = canvas;
            bubbles.Add(ph);
            canvas.Controls.Add(ph);

            string u = url;
            string label = imgPath;
            Task.Run(delegate
            {
                try
                {
                    string sep = u.IndexOf('?') >= 0 ? "&" : "?";
                    string full = u + sep + "token=" + Uri.EscapeDataString(cfg.token);
                    var resp = Api.Http.GetAsync(full).GetAwaiter().GetResult();
                    if (!resp.IsSuccessStatusCode) { Log.W("图片 404 " + label); return; }

                    byte[] bytes = resp.Content.ReadAsByteArrayAsync().GetAwaiter().GetResult();
                    if (bytes == null || bytes.Length < 100) { Log.W("图片太小 " + label); return; }

                    var ms = new MemoryStream(bytes);
                    var img = Image.FromStream(ms);

                    int mw = img.Width, mh = img.Height;
                    float k = Math.Min(1f, 200f / Math.Max(mw, mh));
                    int nw = Math.Max(32, (int)(mw * k));
                    int nh = Math.Max(32, (int)(mh * k));

                    try
                    {
                        BeginInvoke((Action)delegate
                        {
                            ph.Pic = img;
                            ph.Size = new Size(nw, nh);
                            Relayout();
                            ScrollEnd();
                            Log.W("图片已加载 " + label + " " + nw + "x" + nh);
                        });
                    }
                    catch { }
                }
                catch (Exception ex) { Log.W("图片失败 " + label + " " + ex.Message); }
            });
        }

        void OnInputKey(object sender, KeyEventArgs e)
        {
            if (e.KeyCode == Keys.Enter && !e.Shift) { e.SuppressKeyPress = true; SendNow(); }
        }

        void SendNow()
        {
            if (sending) return;
            string t = input.Text.Trim();
            if (t.Length == 0) return;

            input.Text = "";
            sending = true;
            sendBtn.Enabled = false;

            int viewW = scrollHost.ClientSize.Width;
            int maxW = (int)(viewW * 0.78);
            if (maxW < 120) maxW = 240;

            var echo = new Bubble("me", t, pal, maxW);
            echo.Parent = canvas;
            bubbles.Add(echo);
            canvas.Controls.Add(echo);
            Relayout();
            ScrollEnd();

            long now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            if (now > lastAt) lastAt = now;
            pendingMe = t;
            pendingAt = now;

            Task.Run(delegate
            {
                bool ok = Api.Send(cfg, t);
                try
                {
                    BeginInvoke((Action)delegate
                    {
                        sending = false;
                        sendBtn.Enabled = true;
                        if (!ok) SetStatus("发送失败", false);
                    });
                }
                catch { }
            });
        }

        void Reconnect()
        {
            SetStatus("重连中…", false);
            Task.Run(delegate
            {
                string r = Tunnel.Ensure(cfg);
                try
                {
                    BeginInvoke((Action)delegate { SetStatus(r, Tunnel.Open(cfg.port)); Reload(); });
                }
                catch { }
            });
        }

        void ToggleTheme()
        {
            light = !light;
            pal = light ? Palette.Light() : Palette.Dark();
            cfg.theme = light ? "light" : "dark";
            cfg.Save();
            ApplyPal();
            // 气泡的颜色是在构造时定死的，光 Invalidate 不会换色，得重新套一遍调色板
            foreach (var b in bubbles) b.ApplyPalette(pal);
            Relayout();
            Invalidate(true);
        }

        void ShowIt()
        {
            Show();
            WindowState = FormWindowState.Normal;
            BringToFront();
            Activate();
        }

        void OnClosing(object sender, FormClosingEventArgs e)
        {
            Log.W("OnClosing " + e.CloseReason);
            if (!reallyExit && e.CloseReason == CloseReason.UserClosing)
            {
                e.Cancel = true;
                Hide();
                return;
            }
            if (pollTimer != null) pollTimer.Stop();
            Tunnel.Shutdown();
        }
    }

    public class SetupForm : Form
    {
        Settings cfg;
        TextBox tbBase, tbToken, tbKey, tbHost;

        public SetupForm(Settings s)
        {
            cfg = s;
            Text = "配置";
            FormBorderStyle = FormBorderStyle.FixedDialog;
            StartPosition = FormStartPosition.CenterParent;
            MaximizeBox = false;
            MinimizeBox = false;
            ClientSize = new Size(446, 274);

            Controls.Add(new Label
            {
                Text = "第一次用，填一下这几项：",
                AutoSize = true,
                Location = new Point(16, 14),
                Font = new Font("Microsoft YaHei UI", 9.5f, FontStyle.Bold)
            });

            tbBase = Row("服务器地址", 44, cfg.base_url, false);
            tbToken = Row("token", 78, cfg.token, true);
            tbKey = Row("SSH 密钥", 112, cfg.sshKey, false);
            tbHost = Row("SSH 服务器", 146, cfg.sshHost, false);

            Controls.Add(new Label
            {
                Text = "地址：http://127.0.0.1:3081     密钥：D:\\keys\\id_ed25519_xxx     服务器：root@1.2.3.4",
                AutoSize = true,
                Location = new Point(16, 178),
                Font = new Font("Microsoft YaHei UI", 7.8f),
                ForeColor = Color.Gray
            });

            var ok = new Button { Text = "保存并连接", FlatStyle = FlatStyle.Flat, Size = new Size(122, 32), Location = new Point(16, 228) };
            ok.Click += delegate
            {
                cfg.base_url = tbBase.Text.Trim();
                cfg.token = tbToken.Text.Trim();
                cfg.sshKey = tbKey.Text.Trim();
                cfg.sshHost = tbHost.Text.Trim();
                if (cfg.base_url.Length == 0 || cfg.token.Length == 0)
                {
                    MessageBox.Show(this, "地址和 token 都得填。", "还差一点");
                    return;
                }
                cfg.Save();
                DialogResult = DialogResult.OK;
                Close();
            };

            var cancel = new Button { Text = "取消", FlatStyle = FlatStyle.Flat, Size = new Size(80, 32), Location = new Point(150, 228) };
            cancel.Click += delegate { DialogResult = DialogResult.Cancel; Close(); };

            Controls.Add(ok);
            Controls.Add(cancel);
        }

        TextBox Row(string label, int top, string val, bool pwd)
        {
            Controls.Add(new Label { Text = label, AutoSize = true, Location = new Point(16, top + 4) });
            var tb = new TextBox
            {
                Location = new Point(110, top),
                Size = new Size(316, 24),
                Text = val ?? "",
                UseSystemPasswordChar = pwd
            };
            Controls.Add(tb);
            return tb;
        }
    }

    static class Program
    {
        [STAThread]
        static void Main()
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            try
            {
                Log.W("=== 启动 ===");
                Application.Run(new ChatForm());
                Log.W("=== 退出 ===");
            }
            catch (Exception ex)
            {
                Log.W("崩溃: " + ex);
                try { MessageBox.Show(ex.Message, "启动失败"); } catch { }
            }
        }
    }
}
