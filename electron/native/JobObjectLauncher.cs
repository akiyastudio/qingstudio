using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;

internal static class JobObjectLauncher
{
    private const int ProtocolVersion = 1;
    private const int MaxControlFrameBytes = 1024 * 1024;
    private const uint CREATE_SUSPENDED = 0x00000004;
    private const uint CREATE_NO_WINDOW = 0x08000000;
    private const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;
    private const uint STARTF_USESTDHANDLES = 0x00000100;
    private const uint HANDLE_FLAG_INHERIT = 0x00000001;
    private const uint DUPLICATE_SAME_ACCESS = 0x00000002;
    private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
    private const int JobObjectAssociateCompletionPortInformation = 7;
    private const int JobObjectExtendedLimitInformation = 9;
    private const int JobObjectBasicAccountingInformation = 1;
    private const int JobObjectBasicProcessIdList = 3;
    private const uint JOB_OBJECT_MSG_ACTIVE_PROCESS_ZERO = 4;
    private const uint JOB_OBJECT_MSG_NEW_PROCESS = 6;
    private const uint JOB_OBJECT_MSG_EXIT_PROCESS = 7;
    private const uint JOB_OBJECT_MSG_ABNORMAL_EXIT_PROCESS = 8;
    private const uint INFINITE = 0xffffffff;
    private const uint WAIT_TIMEOUT = 258;
    private const int STD_INPUT_HANDLE = -10;
    private const int STD_OUTPUT_HANDLE = -11;
    private const int STD_ERROR_HANDLE = -12;

    [StructLayout(LayoutKind.Sequential)] private struct SECURITY_ATTRIBUTES { public int nLength; public IntPtr lpSecurityDescriptor; [MarshalAs(UnmanagedType.Bool)] public bool bInheritHandle; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] private struct STARTUPINFO { public int cb; public string lpReserved; public string lpDesktop; public string lpTitle; public uint dwX; public uint dwY; public uint dwXSize; public uint dwYSize; public uint dwXCountChars; public uint dwYCountChars; public uint dwFillAttribute; public uint dwFlags; public short wShowWindow; public short cbReserved2; public IntPtr lpReserved2; public IntPtr hStdInput; public IntPtr hStdOutput; public IntPtr hStdError; }
    [StructLayout(LayoutKind.Sequential)] private struct PROCESS_INFORMATION { public IntPtr hProcess; public IntPtr hThread; public uint dwProcessId; public uint dwThreadId; }
    [StructLayout(LayoutKind.Sequential)] private struct IO_COUNTERS { public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount, ReadTransferCount, WriteTransferCount, OtherTransferCount; }
    [StructLayout(LayoutKind.Sequential)] private struct JOBOBJECT_BASIC_LIMIT_INFORMATION { public long PerProcessUserTimeLimit, PerJobUserTimeLimit; public uint LimitFlags; public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize; public uint ActiveProcessLimit; public UIntPtr Affinity; public uint PriorityClass, SchedulingClass; }
    [StructLayout(LayoutKind.Sequential)] private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION { public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation; public IO_COUNTERS IoInfo; public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed; }
    [StructLayout(LayoutKind.Sequential)] private struct JOBOBJECT_ASSOCIATE_COMPLETION_PORT { public IntPtr CompletionKey; public IntPtr CompletionPort; }
    [StructLayout(LayoutKind.Sequential)] private struct JOBOBJECT_BASIC_ACCOUNTING_INFORMATION { public long TotalUserTime, TotalKernelTime, ThisPeriodTotalUserTime, ThisPeriodTotalKernelTime; public uint TotalPageFaultCount, TotalProcesses, ActiveProcesses, TotalTerminatedProcesses; }

    [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] private static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError=true)] private static extern bool SetInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint length);
    [DllImport("kernel32.dll", SetLastError=true)] private static extern bool QueryInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint length, IntPtr returnLength);
    [DllImport("kernel32.dll", SetLastError=true)] private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError=true)] private static extern bool TerminateJobObject(IntPtr job, uint exitCode);
    [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] private static extern bool CreateProcess(string applicationName, StringBuilder commandLine, IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles, uint flags, IntPtr environment, string currentDirectory, ref STARTUPINFO startupInfo, out PROCESS_INFORMATION processInformation);
    [DllImport("kernel32.dll", SetLastError=true)] private static extern bool CreatePipe(out IntPtr readPipe, out IntPtr writePipe, ref SECURITY_ATTRIBUTES attributes, uint size);
    [DllImport("kernel32.dll", SetLastError=true)] private static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
    [DllImport("kernel32.dll", SetLastError=true)] private static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", SetLastError=true)] private static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError=true)] private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError=true)] private static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);
    [DllImport("kernel32.dll", SetLastError=true)] private static extern IntPtr CreateIoCompletionPort(IntPtr file, IntPtr existingPort, IntPtr completionKey, uint threads);
    [DllImport("kernel32.dll", SetLastError=true)] private static extern bool GetQueuedCompletionStatus(IntPtr port, out uint bytes, out IntPtr key, out IntPtr overlapped, uint milliseconds);
    [DllImport("kernel32.dll")] private static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll")] private static extern IntPtr GetStdHandle(int standardHandle);
    [DllImport("kernel32.dll", SetLastError=true)] private static extern bool DuplicateHandle(IntPtr sourceProcess, IntPtr sourceHandle, IntPtr targetProcess, out IntPtr targetHandle, uint access, bool inherit, uint options);

    private sealed class LaunchRequest { public int protocolVersion { get; set; } public string command { get; set; } public string[] args { get; set; } public string cwd { get; set; } public Dictionary<string,string> env { get; set; } public bool windowsHide { get; set; } public string[] stdio { get; set; } public bool pollOnlyForTest { get; set; } }
    private sealed class ControlRequest { public string type { get; set; } public int deadlineMs { get; set; } }

    private static readonly object WriteLock = new object();
    private static NamedPipeServerStream control;
    private static IntPtr job = IntPtr.Zero;
    private static volatile bool terminateRequested;
    private static volatile bool controlFailed;
    private static long terminationDeadlineUtcTicks;
    private static int terminationErrorCode;
    private static Process parentProcess;

    private static void Fail(string stage, int code, string message, bool treeConfirmed = false)
    {
        WriteControl(new Dictionary<string,object> { {"type","error"}, {"protocolVersion",ProtocolVersion}, {"stage",stage}, {"win32Code",code}, {"message",message}, {"treeConfirmed",treeConfirmed}, {"activeProcessCount",treeConfirmed?0:-1} });
    }

    private static void WriteControl(object value)
    {
        try {
            byte[] payload = Encoding.UTF8.GetBytes(new JavaScriptSerializer().Serialize(value));
            if (payload.Length > MaxControlFrameBytes) throw new InvalidDataException("control response too large");
            byte[] length = BitConverter.GetBytes(payload.Length);
            lock (WriteLock) { control.Write(length,0,4); control.Write(payload,0,payload.Length); control.Flush(); }
        } catch { controlFailed = true; RequestTermination(); }
    }

    private static void DrainTerminalControl(int parentPid, long parentStartTicks)
    {
        // PipeStream.Flush does not wait for the peer to consume the bytes.
        // Keep the authoritative terminal frame alive across a busy parent loop,
        // but do not let a dead or unresponsive parent retain this helper forever.
        Task<bool> drain = Task.Factory.StartNew(() => {
            try { control.WaitForPipeDrain(); return true; } catch { return false; }
        }, CancellationToken.None, TaskCreationOptions.LongRunning, TaskScheduler.Default);
        DateTime deadline = DateTime.UtcNow.AddSeconds(5);
        while (!drain.Wait(25)) {
            if (!ParentMatches(parentPid, parentStartTicks) || DateTime.UtcNow >= deadline) return;
        }
        if (!drain.Result) controlFailed = true;
    }

    private static byte[] ReadFrame(Stream stream)
    {
        byte[] lengthBytes = ReadExact(stream,4);
        if (lengthBytes == null) return null;
        int length = BitConverter.ToInt32(lengthBytes,0);
        if (length <= 0 || length > MaxControlFrameBytes) throw new InvalidDataException("invalid control frame length");
        byte[] payload = ReadExact(stream,length);
        if (payload == null) throw new EndOfStreamException("truncated control frame");
        return payload;
    }

    private static byte[] ReadExact(Stream stream, int count)
    {
        byte[] value = new byte[count]; int offset = 0;
        while (offset < count) { int read = stream.Read(value,offset,count-offset); if (read == 0) { if (offset == 0) return null; throw new EndOfStreamException(); } offset += read; }
        return value;
    }

    private static void RequestTermination()
    {
        terminateRequested = true;
        if(Interlocked.Read(ref terminationDeadlineUtcTicks)==0)Interlocked.CompareExchange(ref terminationDeadlineUtcTicks,DateTime.UtcNow.AddSeconds(5).Ticks,0);
        IntPtr current = job;
        if (current != IntPtr.Zero && !TerminateJobObject(current, 137)) Interlocked.CompareExchange(ref terminationErrorCode,Marshal.GetLastWin32Error(),0);
    }

    private static bool ParentMatches(int parentPid, long parentStartTicks)
    {
        try {
            if(parentProcess==null){var candidate=Process.GetProcessById(parentPid);if(Math.Abs(candidate.StartTime.ToUniversalTime().Ticks-parentStartTicks)>TimeSpan.FromSeconds(5).Ticks){candidate.Dispose();return false;}parentProcess=candidate;}
            return parentProcess.Id==parentPid&&!parentProcess.HasExited;
        }
        catch { return false; }
    }

    private static string Quote(string value)
    {
        if (value.Length > 0 && value.IndexOfAny(new[]{' ','\t','\n','\v','"'}) < 0) return value;
        var result = new StringBuilder("\""); int slashes = 0;
        foreach (char c in value) {
            if (c == '\\') { slashes++; continue; }
            if (c == '"') { result.Append('\\',slashes*2+1).Append('"'); slashes=0; continue; }
            result.Append('\\',slashes).Append(c); slashes=0;
        }
        result.Append('\\',slashes*2).Append('"'); return result.ToString();
    }

    private static IntPtr EnvironmentBlock(Dictionary<string,string> environment)
    {
        if (environment == null) return IntPtr.Zero;
        var entries = new List<string>();
        foreach (var pair in environment) if (!String.IsNullOrEmpty(pair.Key) && pair.Key.IndexOf('\0') < 0 && pair.Value != null && pair.Value.IndexOf('\0') < 0) entries.Add(pair.Key + "=" + pair.Value);
        entries.Sort(StringComparer.OrdinalIgnoreCase);
        byte[] bytes = Encoding.Unicode.GetBytes(String.Join("\0",entries) + "\0\0"); IntPtr block = Marshal.AllocHGlobal(bytes.Length); Marshal.Copy(bytes,0,block,bytes.Length); return block;
    }

    private static IntPtr DuplicateNonInheritable(IntPtr source)
    {
        IntPtr duplicate; if (!DuplicateHandle(GetCurrentProcess(),source,GetCurrentProcess(),out duplicate,0,false,DUPLICATE_SAME_ACCESS)) throw new Win32Exception(Marshal.GetLastWin32Error()); return duplicate;
    }

    private static void Close(ref IntPtr handle){if(handle!=IntPtr.Zero){CloseHandle(handle);handle=IntPtr.Zero;}}

    private static Task Relay(IntPtr source, Stream destination)
    {
        return Task.Factory.StartNew(() => { using (var input = new FileStream(new Microsoft.Win32.SafeHandles.SafeFileHandle(source,true),FileAccess.Read,4096,false)) { try { input.CopyTo(destination); destination.Flush(); } catch { RequestTermination(); } } }, CancellationToken.None, TaskCreationOptions.LongRunning, TaskScheduler.Default);
    }

    private static Task RelayInput(IntPtr destination)
    {
        return Task.Factory.StartNew(() => {
            using (var input = Console.OpenStandardInput())
            using (var output = new FileStream(new Microsoft.Win32.SafeHandles.SafeFileHandle(destination,true),FileAccess.Write,4096,false)) {
                try {
                    var buffer = new byte[16 * 1024];
                    while (true) {
                        int count = input.Read(buffer,0,buffer.Length);
                        if (count == 0) break;
                        output.Write(buffer,0,count);
                        // Component RPC frames are commonly much smaller than
                        // FileStream's buffer. Flush each source read so an
                        // interactive target observes every request promptly.
                        output.Flush();
                    }
                } catch { }
            }
        }, CancellationToken.None, TaskCreationOptions.LongRunning, TaskScheduler.Default);
    }

    private static uint ActiveProcessCount()
    {
        int size = Marshal.SizeOf(typeof(JOBOBJECT_BASIC_ACCOUNTING_INFORMATION)); IntPtr memory = Marshal.AllocHGlobal(size);
        try { if (!QueryInformationJobObject(job,JobObjectBasicAccountingInformation,memory,(uint)size,IntPtr.Zero)) throw new Win32Exception(Marshal.GetLastWin32Error()); return ((JOBOBJECT_BASIC_ACCOUNTING_INFORMATION)Marshal.PtrToStructure(memory,typeof(JOBOBJECT_BASIC_ACCOUNTING_INFORMATION))).ActiveProcesses; }
        finally { Marshal.FreeHGlobal(memory); }
    }

    private static List<uint> ProcessIds()
    {
        const int maximum=4096;int header=8;int size=header+maximum*IntPtr.Size;IntPtr memory=Marshal.AllocHGlobal(size);
        try{
            for(int index=0;index<size;index+=1)Marshal.WriteByte(memory,index,0);
            if(!QueryInformationJobObject(job,JobObjectBasicProcessIdList,memory,(uint)size,IntPtr.Zero))throw new Win32Exception(Marshal.GetLastWin32Error());
            uint count=unchecked((uint)Marshal.ReadInt32(memory,4));if(count>maximum)throw new InvalidDataException("Job process list exceeded its safety bound");var result=new List<uint>((int)count);
            for(int index=0;index<count;index+=1){long value=IntPtr.Size==8?Marshal.ReadInt64(memory,header+index*IntPtr.Size):Marshal.ReadInt32(memory,header+index*IntPtr.Size);if(value>0&&value<=UInt32.MaxValue)result.Add(unchecked((uint)value));}
            return result;
        }finally{Marshal.FreeHGlobal(memory);}
    }

    private static void ControlLoop()
    {
        try {
            while (true) {
                byte[] frame = ReadFrame(control); if (frame == null) { RequestTermination(); return; }
                var request = new JavaScriptSerializer().Deserialize<ControlRequest>(Encoding.UTF8.GetString(frame));
                if (request == null || request.type != "terminate" || request.deadlineMs < 1 || request.deadlineMs > 300000) throw new InvalidDataException("invalid control request");
                Interlocked.CompareExchange(ref terminationDeadlineUtcTicks,DateTime.UtcNow.AddMilliseconds(request.deadlineMs).Ticks,0);
                WriteControl(new Dictionary<string,object>{{"type","terminating"},{"protocolVersion",ProtocolVersion}}); RequestTermination();
            }
        } catch (Exception error) { controlFailed = true; RequestTermination(); try { Fail("control", error is Win32Exception ? ((Win32Exception)error).NativeErrorCode : 0, error.Message); } catch { } }
    }

    public static int Main(string[] args)
    {
        string pipeName = Environment.GetEnvironmentVariable("PHOTOFLOW_JOB_PIPE"); int parentPid; long parentStartTicks;
        if (args.Length != 5 || args[0] != "--protocol-v1" || args[1] != "--parent-pid" || !Int32.TryParse(args[2],out parentPid) || args[3] != "--parent-start-ticks" || !Int64.TryParse(args[4],out parentStartTicks) || String.IsNullOrEmpty(pipeName) || pipeName.Length > 240) return 64;
        PROCESS_INFORMATION pi = new PROCESS_INFORMATION(); IntPtr completion = IntPtr.Zero; IntPtr environment = IntPtr.Zero;
        IntPtr stdinRead=IntPtr.Zero,stdinWriteInherited=IntPtr.Zero,stdoutReadInherited=IntPtr.Zero,stdoutWrite=IntPtr.Zero,stderrReadInherited=IntPtr.Zero,stderrWrite=IntPtr.Zero,stdinWrite=IntPtr.Zero,stdoutRead=IntPtr.Zero,stderrRead=IntPtr.Zero;
        try {
            if(!ParentMatches(parentPid,parentStartTicks))return 66;
            control = new NamedPipeServerStream(pipeName,PipeDirection.InOut,1,PipeTransmissionMode.Byte,PipeOptions.Asynchronous,4096,4096);
            IAsyncResult connection=control.BeginWaitForConnection(null,null);
            while(!connection.AsyncWaitHandle.WaitOne(100)){if(!ParentMatches(parentPid,parentStartTicks))return 66;}
            control.EndWaitForConnection(connection); if(!ParentMatches(parentPid,parentStartTicks))return 66;
            Task<byte[]> launchRead=Task.Factory.StartNew(()=>ReadFrame(control),CancellationToken.None,TaskCreationOptions.LongRunning,TaskScheduler.Default);DateTime launchDeadline=DateTime.UtcNow.AddSeconds(5);
            while(!launchRead.Wait(100)){if(!ParentMatches(parentPid,parentStartTicks))return 66;if(DateTime.UtcNow>=launchDeadline){Fail("launch-frame-deadline",unchecked((int)WAIT_TIMEOUT),"Launch control frame did not complete before deadline",true);return 1460;}}
            byte[] launchBytes = launchRead.Result; if (launchBytes == null) return 65;
            var serializer = new JavaScriptSerializer { MaxJsonLength = MaxControlFrameBytes };
            var request = serializer.Deserialize<LaunchRequest>(Encoding.UTF8.GetString(launchBytes));
            if (request == null || request.protocolVersion != ProtocolVersion || String.IsNullOrWhiteSpace(request.command) || request.command.IndexOf('\0') >= 0 || request.args == null || request.args.Length > 4096 || request.cwd == null || request.cwd.IndexOf('\0') >= 0 || request.stdio == null || request.stdio.Length != 3) throw new InvalidDataException("invalid launch request");
            foreach (string argument in request.args) if (argument == null || argument.IndexOf('\0') >= 0) throw new InvalidDataException("invalid target argument");
            foreach(string mode in request.stdio)if(mode!="pipe"&&mode!="ignore")throw new InvalidDataException("invalid stdio policy");
            if(request.env!=null)foreach(var pair in request.env)if(String.IsNullOrEmpty(pair.Key)||pair.Key.IndexOfAny(new[]{'\0','='})>=0||pair.Value==null||pair.Value.IndexOf('\0')>=0)throw new InvalidDataException("invalid environment entry");

            // Node's helper-side stdio handles must never leak into the target.
            // Only the three child ends created below remain inheritable when
            // CreateProcess runs, which prevents competing stdin readers and
            // hidden pipe references that would delay EOF.
            foreach(int standardHandle in new[]{STD_INPUT_HANDLE,STD_OUTPUT_HANDLE,STD_ERROR_HANDLE}){IntPtr inherited=GetStdHandle(standardHandle);if(inherited!=IntPtr.Zero&&inherited!=new IntPtr(-1)&&!SetHandleInformation(inherited,HANDLE_FLAG_INHERIT,0))throw new Win32Exception(Marshal.GetLastWin32Error());}

            var sa = new SECURITY_ATTRIBUTES { nLength=Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES)), bInheritHandle=true };
            if (!CreatePipe(out stdinRead,out stdinWriteInherited,ref sa,0) || !CreatePipe(out stdoutReadInherited,out stdoutWrite,ref sa,0) || !CreatePipe(out stderrReadInherited,out stderrWrite,ref sa,0)) throw new Win32Exception(Marshal.GetLastWin32Error());
            stdinWrite=DuplicateNonInheritable(stdinWriteInherited);stdoutRead=DuplicateNonInheritable(stdoutReadInherited);stderrRead=DuplicateNonInheritable(stderrReadInherited);
            Close(ref stdinWriteInherited);Close(ref stdoutReadInherited);Close(ref stderrReadInherited);

            job = CreateJobObject(IntPtr.Zero,null); if (job == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
            completion = CreateIoCompletionPort(new IntPtr(-1),IntPtr.Zero,IntPtr.Zero,1); if (completion == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
            var limits = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION(); limits.BasicLimitInformation.LimitFlags=JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            int limitSize=Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION)); IntPtr limitMemory=Marshal.AllocHGlobal(limitSize);
            try { Marshal.StructureToPtr(limits,limitMemory,false); if(!SetInformationJobObject(job,JobObjectExtendedLimitInformation,limitMemory,(uint)limitSize))throw new Win32Exception(Marshal.GetLastWin32Error()); } finally { Marshal.FreeHGlobal(limitMemory); }
            var association=new JOBOBJECT_ASSOCIATE_COMPLETION_PORT{CompletionKey=new IntPtr(1),CompletionPort=completion}; int associationSize=Marshal.SizeOf(typeof(JOBOBJECT_ASSOCIATE_COMPLETION_PORT));IntPtr associationMemory=Marshal.AllocHGlobal(associationSize);
            try { Marshal.StructureToPtr(association,associationMemory,false); if(!SetInformationJobObject(job,JobObjectAssociateCompletionPortInformation,associationMemory,(uint)associationSize))throw new Win32Exception(Marshal.GetLastWin32Error()); } finally { Marshal.FreeHGlobal(associationMemory); }

            var si=new STARTUPINFO{cb=Marshal.SizeOf(typeof(STARTUPINFO)),dwFlags=STARTF_USESTDHANDLES,hStdInput=stdinRead,hStdOutput=stdoutWrite,hStdError=stderrWrite};
            var commandLine=new StringBuilder(Quote(request.command)); foreach(string argument in request.args)commandLine.Append(' ').Append(Quote(argument)); environment=EnvironmentBlock(request.env);
            uint flags=CREATE_SUSPENDED|CREATE_UNICODE_ENVIRONMENT|(request.windowsHide?CREATE_NO_WINDOW:0);
            if(!CreateProcess(request.command,commandLine,IntPtr.Zero,IntPtr.Zero,true,flags,environment,String.IsNullOrEmpty(request.cwd)?null:request.cwd,ref si,out pi)){int code=Marshal.GetLastWin32Error();bool confirmed=ActiveProcessCount()==0;Fail("create-process",code,new Win32Exception(code).Message,confirmed);return code==0?1:code;}
            Close(ref stdinRead);Close(ref stdoutWrite);Close(ref stderrWrite);
            if(!AssignProcessToJobObject(job,pi.hProcess)){int code=Marshal.GetLastWin32Error();TerminateProcessFallback(pi.hProcess);bool targetExited=WaitForSingleObject(pi.hProcess,5000)==0;bool confirmed=targetExited&&ActiveProcessCount()==0;Fail("assign-job",code,new Win32Exception(code).Message,confirmed);return code==0?1:code;}
            if(ResumeThread(pi.hThread)==0xffffffff){int code=Marshal.GetLastWin32Error();bool terminated=TerminateJobObject(job,137);bool targetExited=WaitForSingleObject(pi.hProcess,5000)==0;bool confirmed=terminated&&targetExited&&ActiveProcessCount()==0;if(!terminated){int terminateCode=Marshal.GetLastWin32Error();Fail("resume-cleanup",terminateCode,new Win32Exception(terminateCode).Message,false);}Fail("resume-thread",code,new Win32Exception(code).Message,confirmed);return code==0?1:code;}
            Close(ref pi.hThread);
            WriteControl(new Dictionary<string,object>{{"type","ready"},{"protocolVersion",ProtocolVersion},{"targetPid",pi.dwProcessId}});
            Task stdoutRelay=Relay(stdoutRead,request.stdio[1]=="pipe"?Console.OpenStandardOutput():Stream.Null);stdoutRead=IntPtr.Zero; Task stderrRelay=Relay(stderrRead,request.stdio[2]=="pipe"?Console.OpenStandardError():Stream.Null);stderrRead=IntPtr.Zero;
            if(request.stdio[0]=="pipe"){RelayInput(stdinWrite);stdinWrite=IntPtr.Zero;}else Close(ref stdinWrite);
            new Thread(ControlLoop){IsBackground=true,Name="job-control"}.Start();
            uint rootExitCode=0; bool rootExitKnown=false; bool orphanDescendants=false;long rootExitedAtTicks=0;
            while(true){
                uint message=0;IntPtr key=IntPtr.Zero,overlapped=IntPtr.Zero;bool dequeued;if(request.pollOnlyForTest){Thread.Sleep(100);dequeued=false;}else dequeued=GetQueuedCompletionStatus(completion,out message,out key,out overlapped,100);
                if(!dequeued){int code=request.pollOnlyForTest?unchecked((int)WAIT_TIMEOUT):Marshal.GetLastWin32Error();if(code!=unchecked((int)WAIT_TIMEOUT)){Fail("job-monitor",code,new Win32Exception(code).Message);RequestTermination();return code==0?1:code;}}
                if(!ParentMatches(parentPid,parentStartTicks))RequestTermination();
                if(!rootExitKnown&&WaitForSingleObject(pi.hProcess,0)==0){rootExitKnown=GetExitCodeProcess(pi.hProcess,out rootExitCode);rootExitedAtTicks=DateTime.UtcNow.Ticks;}
                List<uint> processIds=ProcessIds();uint active=ActiveProcessCount();
                if(active==0&&processIds.Count==0){if(!Task.WaitAll(new[]{stdoutRelay,stderrRelay},5000)){Fail("stdio-drain",unchecked((int)WAIT_TIMEOUT),"Target output did not drain before deadline",true);return 1460;}WriteControl(new Dictionary<string,object>{{"type","tree-exit"},{"protocolVersion",ProtocolVersion},{"targetPid",pi.dwProcessId},{"activeProcessCount",0},{"targetExitCode",rootExitKnown?(object)rootExitCode:null},{"terminated",terminateRequested},{"orphanDescendants",orphanDescendants}});DrainTerminalControl(parentPid,parentStartTicks);if(orphanDescendants&&rootExitKnown&&rootExitCode==0)return 125;return rootExitKnown?unchecked((int)rootExitCode):(terminateRequested?137:0);}
                if(rootExitKnown&&DateTime.UtcNow.Ticks-rootExitedAtTicks>=TimeSpan.FromMilliseconds(250).Ticks&&processIds.Exists(value=>value!=pi.dwProcessId)){orphanDescendants=true;RequestTermination();}
                int terminateCode=Interlocked.CompareExchange(ref terminationErrorCode,0,0);if(terminateCode!=0){Fail("terminate-job",terminateCode,new Win32Exception(terminateCode).Message);return terminateCode;}
                long deadline=Interlocked.Read(ref terminationDeadlineUtcTicks);if(terminateRequested&&deadline>0&&DateTime.UtcNow.Ticks>=deadline){Fail("terminate-deadline",unchecked((int)WAIT_TIMEOUT),"Job did not reach ActiveProcesses=0 before deadline");return 1460;}
            }
        } catch(Exception error) { int code=error is Win32Exception?((Win32Exception)error).NativeErrorCode:0;bool confirmed=false;if(pi.hProcess==IntPtr.Zero){try{confirmed=job==IntPtr.Zero||ActiveProcessCount()==0;}catch{confirmed=false;}}else{RequestTermination();bool targetExited=WaitForSingleObject(pi.hProcess,5000)==0;try{confirmed=targetExited&&ActiveProcessCount()==0;}catch{confirmed=false;}}try{Fail("launcher",code,error.Message,confirmed);}catch{}return code==0?1:code; }
        finally { if(environment!=IntPtr.Zero)Marshal.FreeHGlobal(environment);Close(ref stdinRead);Close(ref stdinWriteInherited);Close(ref stdoutReadInherited);Close(ref stdoutWrite);Close(ref stderrReadInherited);Close(ref stderrWrite);Close(ref stdinWrite);Close(ref stdoutRead);Close(ref stderrRead);Close(ref pi.hThread);Close(ref pi.hProcess);Close(ref job);Close(ref completion);if(control!=null)control.Dispose();if(parentProcess!=null)parentProcess.Dispose(); }
    }

    [DllImport("kernel32.dll", SetLastError=true)] private static extern bool TerminateProcess(IntPtr process,uint exitCode);
    private static void TerminateProcessFallback(IntPtr process){try{TerminateProcess(process,137);}catch{}}
}
