using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Web.Script.Serialization;

internal static class Native
{
    internal const int GWL_STYLE = -16; internal const long WS_CHILD = 0x40000000L; internal const long WS_POPUP = 0x80000000L; internal const long WS_CAPTION = 0x00C00000L;
    internal const uint SWP_NOACTIVATE = 0x0010, SWP_SHOWWINDOW = 0x0040; internal const int SW_HIDE = 0, SW_SHOWNOACTIVATE = 4, RGN_DIFF = 4;
    [DllImport("user32.dll", SetLastError=true)] internal static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
    [DllImport("user32.dll", SetLastError=true)] internal static extern IntPtr SetParent(IntPtr child, IntPtr parent);
    [DllImport("user32.dll", SetLastError=true)] internal static extern IntPtr GetParent(IntPtr window);
    [DllImport("user32.dll", EntryPoint="GetWindowLongPtr", SetLastError=true)] internal static extern IntPtr GetWindowLongPtr64(IntPtr window, int index);
    [DllImport("user32.dll", EntryPoint="GetWindowLong", SetLastError=true)] internal static extern IntPtr GetWindowLongPtr32(IntPtr window, int index);
    [DllImport("user32.dll", EntryPoint="SetWindowLongPtr", SetLastError=true)] internal static extern IntPtr SetWindowLongPtr64(IntPtr window, int index, IntPtr value);
    [DllImport("user32.dll", EntryPoint="SetWindowLong", SetLastError=true)] internal static extern IntPtr SetWindowLongPtr32(IntPtr window, int index, IntPtr value);
    [DllImport("user32.dll", SetLastError=true)] internal static extern bool SetWindowPos(IntPtr window, IntPtr after, int x, int y, int width, int height, uint flags);
    [DllImport("user32.dll")] internal static extern bool ShowWindow(IntPtr window, int command);
    [DllImport("user32.dll", SetLastError=true)] internal static extern int SetWindowRgn(IntPtr window, IntPtr region, bool redraw);
    [DllImport("user32.dll", SetLastError=true)] internal static extern int GetWindowRgn(IntPtr window, IntPtr region);
    [DllImport("user32.dll", SetLastError=true)] internal static extern bool SetProcessDpiAwarenessContext(IntPtr value);
    [StructLayout(LayoutKind.Sequential)] internal struct Rect { internal int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] internal struct MonitorInfo { internal int Size; internal Rect Monitor, Work; internal uint Flags; }
    [DllImport("user32.dll")] internal static extern IntPtr MonitorFromWindow(IntPtr window, uint flags);
    [DllImport("user32.dll", CharSet=CharSet.Auto)] internal static extern bool GetMonitorInfo(IntPtr monitor, ref MonitorInfo info);
    [DllImport("user32.dll")] internal static extern bool SetForegroundWindow(IntPtr window);
    [DllImport("gdi32.dll")] internal static extern IntPtr CreateRectRgn(int left, int top, int right, int bottom);
    [DllImport("gdi32.dll")] internal static extern IntPtr CreateEllipticRgn(int left, int top, int right, int bottom);
    [DllImport("gdi32.dll")] internal static extern IntPtr CreateRoundRectRgn(int left, int top, int right, int bottom, int ellipseWidth, int ellipseHeight);
    [DllImport("gdi32.dll")] internal static extern int CombineRgn(IntPtr destination, IntPtr source1, IntPtr source2, int mode);
    [DllImport("gdi32.dll")] internal static extern bool DeleteObject(IntPtr value);
    [DllImport("kernel32.dll")] internal static extern void SetLastError(uint error);
    internal static bool TryGetStyle(IntPtr window,out IntPtr style) { SetLastError(0); style=IntPtr.Size==8?GetWindowLongPtr64(window,GWL_STYLE):GetWindowLongPtr32(window,GWL_STYLE); return style!=IntPtr.Zero||Marshal.GetLastWin32Error()==0; }
    internal static bool SetStyle(IntPtr window, IntPtr style) { SetLastError(0); IntPtr previous=IntPtr.Size == 8 ? SetWindowLongPtr64(window,GWL_STYLE,style) : SetWindowLongPtr32(window,GWL_STYLE,style); return previous!=IntPtr.Zero||Marshal.GetLastWin32Error()==0; }
}

internal static class Program
{
    private static void Parent(IntPtr child, IntPtr parent) {
        Native.SetLastError(0);
        if(Native.SetParent(child,parent)==IntPtr.Zero&&Marshal.GetLastWin32Error()!=0)throw new InvalidOperationException("surface parent change failed");
    }
    private static void Fullscreen(IntPtr child, IntPtr parent, IntPtr embeddedStyle, bool enabled, Dictionary<string,object> bounds) {
        if(enabled) {
            var monitor = new Native.MonitorInfo(); monitor.Size=Marshal.SizeOf(monitor);
            if(!Native.GetMonitorInfo(Native.MonitorFromWindow(child,2),ref monitor))throw new InvalidOperationException("fullscreen monitor unavailable");
            Native.ShowWindow(child,Native.SW_HIDE);
            Parent(child,IntPtr.Zero);
            if(!Native.SetStyle(child,new IntPtr((embeddedStyle.ToInt64()|Native.WS_POPUP)&~Native.WS_CHILD&~Native.WS_CAPTION)))throw new InvalidOperationException("fullscreen style failed");
            if(Native.SetWindowRgn(child,IntPtr.Zero,true)==0)throw new InvalidOperationException("fullscreen clip reset failed");
            var r=monitor.Monitor;
            // Keep normal z-order so switching applications remains possible.
            if(!Native.SetWindowPos(child,IntPtr.Zero,r.Left,r.Top,r.Right-r.Left,r.Bottom-r.Top,Native.SWP_SHOWWINDOW|0x0020))throw new InvalidOperationException("fullscreen position failed");
            Native.SetForegroundWindow(child);
        } else {
            Native.ShowWindow(child,Native.SW_HIDE);
            if(!Native.SetStyle(child,embeddedStyle))throw new InvalidOperationException("fullscreen style restore failed");
            Parent(child,parent);
            if(bounds!=null)Bounds(child,bounds);
            Native.SetForegroundWindow(parent);
        }
    }
    private static int ReadInt(Dictionary<string, object> value, string key) { object raw; double number; return value.TryGetValue(key, out raw) && double.TryParse(Convert.ToString(raw, CultureInfo.InvariantCulture), out number) ? (int)Math.Round(number) : 0; }
    private static void Cut(IntPtr region, Dictionary<string, object> value, string prefix, bool ellipse)
    {
        int x=ReadInt(value,prefix+"X"), y=ReadInt(value,prefix+"Y"), w=ReadInt(value,prefix+"Width"), h=ReadInt(value,prefix+"Height"), radius=Math.Max(0,ReadInt(value,prefix+"Radius")); if(w<=0||h<=0)return;
        IntPtr hole=ellipse?Native.CreateEllipticRgn(x,y,x+w,y+h):radius>0?Native.CreateRoundRectRgn(x,y,x+w,y+h,radius*2,radius*2):Native.CreateRectRgn(x,y,x+w,y+h); if(hole==IntPtr.Zero)throw new InvalidOperationException("surface region allocation failed"); try{if(Native.CombineRgn(region,region,hole,Native.RGN_DIFF)==0)throw new InvalidOperationException("surface region combine failed");}finally{Native.DeleteObject(hole);}
    }
    private static void Bounds(IntPtr child, Dictionary<string, object> value)
    {
        int x=ReadInt(value,"x"),y=ReadInt(value,"y"),w=Math.Max(1,ReadInt(value,"width")),h=Math.Max(1,ReadInt(value,"height"));
        IntPtr region=Native.CreateRectRgn(0,0,w,h); if(region==IntPtr.Zero)throw new InvalidOperationException("surface region allocation failed"); try{Cut(region,value,"hole",false);Cut(region,value,"controlsHole",false);Cut(region,value,"cornerHole",true);if(Native.SetWindowRgn(child,region,true)==0)throw new InvalidOperationException("surface region apply failed");region=IntPtr.Zero;}finally{if(region!=IntPtr.Zero)Native.DeleteObject(region);}
        bool visible=value.ContainsKey("visible")&&Convert.ToBoolean(value["visible"])&&ReadInt(value,"width")>0&&ReadInt(value,"height")>0;
        if(visible){Native.ShowWindow(child,Native.SW_SHOWNOACTIVATE);if(!Native.SetWindowPos(child,IntPtr.Zero,x,y,w,h,Native.SWP_NOACTIVATE|Native.SWP_SHOWWINDOW))throw new InvalidOperationException("surface position failed");}else Native.ShowWindow(child,Native.SW_HIDE);
    }
    private static long Arg(string[] args,string name){for(int i=0;i+1<args.Length;i++)if(args[i]==name){long value;return long.TryParse(args[i+1],out value)?value:0;}return 0;}
    private static string TextArg(string[] args,string name){for(int i=0;i+1<args.Length;i++)if(args[i]==name)return args[i+1];return string.Empty;}
    private static int Main(string[] args)
    {
        Console.InputEncoding=new UTF8Encoding(false);Console.OutputEncoding=new UTF8Encoding(false);var serializer=new JavaScriptSerializer{MaxJsonLength=256*1024};
        try { Native.SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch { }
        IntPtr parent=new IntPtr(Arg(args,"--parent-hwnd")),child=new IntPtr(Arg(args,"--child-hwnd"));uint expected=(uint)Arg(args,"--expected-pid"),actual;string sessionId=TextArg(args,"--session-id");
        if(parent==IntPtr.Zero||child==IntPtr.Zero||expected==0||string.IsNullOrWhiteSpace(sessionId)||Native.GetWindowThreadProcessId(child,out actual)==0||actual!=expected){Console.Error.WriteLine("surface ownership validation failed");return 2;}
        uint hostProcessId;
        if(Native.GetWindowThreadProcessId(parent,out hostProcessId)==0||hostProcessId==0){Console.Error.WriteLine("parent ownership validation failed");return 2;}
        Native.SetLastError(0);IntPtr originalParent=Native.GetParent(child);if(originalParent==IntPtr.Zero&&Marshal.GetLastWin32Error()!=0){Console.Error.WriteLine("surface parent capture failed");return 3;}IntPtr originalStyle;if(!Native.TryGetStyle(child,out originalStyle)){Console.Error.WriteLine("surface style capture failed");return 3;}IntPtr originalRegion=Native.CreateRectRgn(0,0,0,0);if(originalRegion==IntPtr.Zero){Console.Error.WriteLine("surface state capture failed");return 3;}Native.SetLastError(0);int originalRegionState=Native.GetWindowRgn(child,originalRegion);if(originalRegionState==0){int regionError=Marshal.GetLastWin32Error();Native.DeleteObject(originalRegion);originalRegion=IntPtr.Zero;if(regionError!=0){Console.Error.WriteLine("surface state capture failed");return 3;}}else if(originalRegionState==1){Native.DeleteObject(originalRegion);originalRegion=IntPtr.Zero;}
        bool attached=false,fullscreen=false;
        Dictionary<string,object> latestBounds=null;
        IntPtr embeddedStyle=new IntPtr((originalStyle.ToInt64()|Native.WS_CHILD)&~Native.WS_POPUP&~Native.WS_CAPTION);
        try{
            if(!Native.SetStyle(child,embeddedStyle))throw new InvalidOperationException("surface style attach failed");
            Native.SetLastError(0);if(Native.SetParent(child,parent)==IntPtr.Zero&&Marshal.GetLastWin32Error()!=0)throw new InvalidOperationException("surface attach failed");attached=true;Native.ShowWindow(child,Native.SW_HIDE);Console.Out.WriteLine(serializer.Serialize(new Dictionary<string,object>{{"type","ready"},{"sessionId",sessionId}}));Console.Out.Flush();
            string line;while((line=Console.In.ReadLine())!=null){if(Encoding.UTF8.GetByteCount(line)>256*1024)throw new InvalidOperationException("frame too large");var value=serializer.Deserialize<Dictionary<string,object>>(line);object command;if(!value.TryGetValue("command",out command))continue;string name=Convert.ToString(command);if(name=="close")break;
                if(name=="bounds"){
                    latestBounds=value;
                    bool visible=value.ContainsKey("visible")&&Convert.ToBoolean(value["visible"])&&ReadInt(value,"width")>1&&ReadInt(value,"height")>1;
                    if(fullscreen&&!visible){Fullscreen(child,parent,embeddedStyle,false,latestBounds);fullscreen=false;}
                    if(!fullscreen)Bounds(child,value);
                }
                if(name=="fullscreen"){
                    bool next=value.ContainsKey("value")?Convert.ToBoolean(value["value"]):!fullscreen;
                    if(next!=fullscreen&&(!next||latestBounds!=null&&latestBounds.ContainsKey("visible")&&Convert.ToBoolean(latestBounds["visible"]))){Fullscreen(child,parent,embeddedStyle,next,latestBounds);fullscreen=next;}
                }
                if(name=="parent"){
                    bool success=false;object rawParent,requestId;long handle;uint nextProcessId,childProcessId;
                    value.TryGetValue("requestId",out requestId);
                    if(value.TryGetValue("parentHandle",out rawParent)&&long.TryParse(Convert.ToString(rawParent),out handle)&&handle>0){
                        IntPtr nextParent=new IntPtr(handle);
                        if(Native.GetWindowThreadProcessId(nextParent,out nextProcessId)!=0&&nextProcessId==hostProcessId&&Native.GetWindowThreadProcessId(child,out childProcessId)!=0&&childProcessId==expected){
                            if(fullscreen){Fullscreen(child,parent,embeddedStyle,false,latestBounds);fullscreen=false;}
                            Native.ShowWindow(child,Native.SW_HIDE);Native.SetLastError(0);
                            success=Native.SetParent(child,nextParent)!=IntPtr.Zero||Marshal.GetLastWin32Error()==0;
                            if(success)parent=nextParent;
                        }
                    }
                    Console.Out.WriteLine(serializer.Serialize(new Dictionary<string,object>{{"type","parent-changed"},{"sessionId",sessionId},{"requestId",requestId},{"success",success}}));Console.Out.Flush();
                }
            }
        }
        catch(Exception error){Console.Error.WriteLine(error.Message);return 3;}
        finally{
            Native.ShowWindow(child,Native.SW_HIDE);if(attached){Native.SetLastError(0);IntPtr previousParent=Native.SetParent(child,originalParent);if(previousParent==IntPtr.Zero&&Marshal.GetLastWin32Error()!=0)Console.Error.WriteLine("surface parent restore failed");}if(!Native.SetStyle(child,originalStyle))Console.Error.WriteLine("surface style restore failed");
            if(Native.SetWindowRgn(child,originalRegion,true)!=0)originalRegion=IntPtr.Zero;else Console.Error.WriteLine("surface region restore failed");
            if(originalRegion!=IntPtr.Zero)Native.DeleteObject(originalRegion);
        }return 0;
    }
}
