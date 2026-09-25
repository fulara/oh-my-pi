//! Cross-platform process tree management.

use std::{
	collections::{HashMap, HashSet},
	sync::Arc,
	time::Duration,
};

use anyhow::Result;
use parking_lot::Mutex;
/// Current state of a process reference.
///
/// Defined in `pi-builtins` alongside the process-table snapshots its process
/// builtins read, and re-exported here so this module — and `pi-natives`
/// through it — keeps one status type for both concerns.
pub use pi_builtins::ProcessStatus;

use crate::cancel::CancelToken;

#[cfg(target_os = "linux")]
mod platform {
	use std::{
		collections::HashSet,
		fs,
		os::fd::{AsFd, AsRawFd, OwnedFd},
		sync::{Arc, LazyLock},
	};

	use pi_builtins::proc_sys as sys;

	use super::ProcessStatus;

	/// Stable Linux process reference backed by a pidfd.
	#[derive(Clone)]
	pub struct Process {
		pid:        i32,
		pidfd:      Arc<OwnedFd>,
		start_time: u64,
		boot_id:    &'static str,
	}

	impl Process {
		pub fn from_pid(pid: i32) -> Option<Self> {
			if pid <= 0 {
				return None;
			}
			let pidfd = Arc::new(sys::open_pidfd(pid)?);
			let start_time = sys::start_time(pid)?;
			static BOOT_ID: LazyLock<Option<String>> = LazyLock::new(|| {
				fs::read_to_string("/proc/sys/kernel/random/boot_id")
					.ok()
					.map(|id| id.trim().to_owned())
					.filter(|id| !id.is_empty())
			});
			let boot_id = BOOT_ID.as_deref()?;
			let process = Self { pid, pidfd, start_time, boot_id };
			process.live_identity().then_some(process)
		}

		pub const fn pid(&self) -> i32 {
			self.pid
		}

		pub fn identity(&self) -> String {
			format!("linux:{}:{}:{}", self.boot_id, self.pid, self.start_time)
		}

		pub fn children(&self) -> Vec<Self> {
			if !self.live_identity() {
				return Vec::new();
			}

			// `/proc/{pid}/task/{tid}/children` is per-task: a child fork()ed from
			// a worker thread appears under that thread's `tid`, not the tgid.
			// Walk every task subdir and union the lists, then re-validate
			// parentage.
			let task_dir = format!("/proc/{}/task", self.pid);
			let Ok(entries) = fs::read_dir(&task_dir) else {
				return Vec::new();
			};

			let mut seen: HashSet<i32> = HashSet::new();
			let mut out = Vec::new();
			let mut children_file_available = false;
			for entry in entries.flatten() {
				let name = entry.file_name();
				let Some(tid_str) = name.to_str() else {
					continue;
				};
				if tid_str.parse::<i32>().is_err() {
					continue;
				}
				let children_path = format!("/proc/{}/task/{}/children", self.pid, tid_str);
				let Ok(content) = fs::read_to_string(&children_path) else {
					continue;
				};
				// The file is readable -> this kernel has CONFIG_PROC_CHILDREN.
				children_file_available = true;
				for part in content.split_whitespace() {
					let Ok(child_pid) = part.parse::<i32>() else {
						continue;
					};
					self.push_validated_child(child_pid, &mut seen, &mut out);
				}
			}

			// Some Kata / microVM guest kernels are built without
			// CONFIG_PROC_CHILDREN, so no `.../children` file exists and the
			// walk above finds nothing — which would silently turn descendant
			// signaling (cancellation cleanup) into a no-op inside such
			// containers. Fall back to scanning `/proc` and grouping
			// by parent pid, the same primitive the macOS path uses. Only taken
			// when no `children` file was readable, so kernels that support it
			// keep the cheap per-task fast path.
			if !children_file_available {
				for child_pid in sys::pids() {
					self.push_validated_child(child_pid, &mut seen, &mut out);
				}
			}
			out
		}

		/// Validate a candidate child pid — dedup, still running, and currently
		/// parented to `self` — then push it onto `out`. Shared by the
		/// `/proc/<pid>/task/<tid>/children` fast path and the `/proc`-scan
		/// fallback for kernels without `CONFIG_PROC_CHILDREN`.
		fn push_validated_child(&self, child_pid: i32, seen: &mut HashSet<i32>, out: &mut Vec<Self>) {
			if child_pid == self.pid || !seen.insert(child_pid) {
				return;
			}
			let Some(child) = Self::from_pid(child_pid) else {
				return;
			};
			if child.live_identity() && child.parent_pid() == Some(self.pid) && self.live_identity() {
				out.push(child);
			}
		}

		pub fn parent_pid(&self) -> Option<i32> {
			if !self.live_identity() {
				return None;
			}
			let parent = sys::parent_pid(self.pid)?;
			self.live_identity().then_some(parent)
		}

		pub fn args(&self) -> Vec<String> {
			if !self.live_identity() {
				return Vec::new();
			}

			let Some(args) = sys::cmdline(self.pid) else {
				return Vec::new();
			};
			// Re-validate after the read: PID reuse between identity check and
			// read would otherwise leak an impostor's command line to callers.
			if !self.live_identity() {
				return Vec::new();
			}
			args
		}

		pub fn kill(&self, signal: i32) -> bool {
			sys::pidfd_send_signal(self.pidfd.as_fd(), signal)
		}

		pub fn group_id(&self) -> Option<i32> {
			if !self.live_identity() {
				return None;
			}

			// SAFETY: `getpgid` takes a scalar PID. Revalidate the pinned identity
			// after querying so a recycled PID cannot supply an unrelated group.
			let pgid = unsafe { libc::getpgid(self.pid) };
			(pgid >= 0 && self.live_identity()).then_some(pgid)
		}

		pub fn status(&self) -> ProcessStatus {
			loop {
				let mut pollfd =
					libc::pollfd { fd: self.pidfd.as_raw_fd(), events: libc::POLLIN, revents: 0 };
				// SAFETY: `pollfd` points to one initialized `pollfd` element, and
				// the pidfd remains open for the duration of the call. Timeout
				// zero makes this a non-blocking readiness probe.
				let ready = unsafe { libc::poll(&raw mut pollfd, 1, 0) };
				if ready < 0 {
					// Retry on EINTR; for any other transient poll error treat the
					// pidfd as still running. The pidfd is still owned and the
					// kernel has not reported the process gone — a spurious
					// `Exited` here makes every downstream signal/kill fall
					// through silently.
					if std::io::Error::last_os_error().raw_os_error() == Some(libc::EINTR) {
						continue;
					}
					return ProcessStatus::Running;
				}
				if ready == 0 {
					return ProcessStatus::Running;
				}
				if (pollfd.revents & (libc::POLLIN | libc::POLLHUP | libc::POLLERR | libc::POLLNVAL))
					!= 0
				{
					return ProcessStatus::Exited;
				}
				return ProcessStatus::Running;
			}
		}

		/// Resolves once the process exits: its pidfd becomes readable then.
		pub async fn exited(&self) -> std::io::Result<()> {
			let pidfd = tokio::io::unix::AsyncFd::with_interest(
				self.pidfd.try_clone()?,
				tokio::io::Interest::READABLE,
			)?;
			let _ready = pidfd.readable().await?;
			Ok(())
		}

		/// Walk the descendant tree in post-order (leaves first), de-duplicating
		/// by PID so concurrent reparenting cannot trap us in a cycle.
		pub fn descendants(&self) -> Vec<Self> {
			let mut out = Vec::new();
			let mut visited = HashSet::new();
			visited.insert(self.pid);
			self.descendants_into(&mut out, &mut visited);
			out
		}

		fn descendants_into(&self, out: &mut Vec<Self>, visited: &mut HashSet<i32>) {
			for child in self.children() {
				if visited.insert(child.pid) {
					child.descendants_into(out, visited);
					out.push(child);
				}
			}
		}

		fn live_identity(&self) -> bool {
			self.status() == ProcessStatus::Running
				&& sys::start_time(self.pid) == Some(self.start_time)
		}
	}

	/// Find processes whose `/proc/{pid}/exe` symlink resolves to exactly
	/// `target`.
	pub fn find_by_path(target: &str) -> Vec<Process> {
		sys::pids()
			.filter(|pid| {
				fs::read_link(format!("/proc/{pid}/exe"))
					.is_ok_and(|resolved| resolved.as_os_str() == target)
			})
			.filter_map(Process::from_pid)
			.collect()
	}
}

#[cfg(target_os = "macos")]
mod platform {
	use std::{
		collections::{HashMap, HashSet},
		ptr,
	};

	use pi_builtins::proc_sys as sys;

	use super::ProcessStatus;

	/// macOS does not expose pidfds; identity is pinned via the kernel-reported
	/// process start time so a recycled PID does not silently impersonate the
	/// original target.
	#[derive(Clone)]
	pub struct Process {
		pid:          i32,
		start_tvsec:  u64,
		start_tvusec: u64,
	}

	impl Process {
		pub fn from_pid(pid: i32) -> Option<Self> {
			if pid <= 0 {
				return None;
			}
			let info = sys::bsdinfo(pid)?;
			if i32::try_from(info.pbi_pid).ok()? != pid {
				return None;
			}
			Some(Self { pid, start_tvsec: info.pbi_start_tvsec, start_tvusec: info.pbi_start_tvusec })
		}

		pub const fn pid(&self) -> i32 {
			self.pid
		}

		pub fn identity(&self) -> String {
			format!("macos:{}:{}:{}", self.pid, self.start_tvsec, self.start_tvusec)
		}

		pub fn children(&self) -> Vec<Self> {
			if self.live_bsdinfo().is_none() {
				return Vec::new();
			}
			// `proc_listchildpids` (the obvious choice) is broken on recent macOS
			// kernels when queried for the *calling* process — it returns one byte
			// of padding regardless of how many children the process actually
			// has, so a process can never list its own descendants. Confirmed
			// on darwin 25.4 from C, Rust, and Bun callers via
			// `proc_listchildpids(getpid(), …)`, while `ps -P` and `pgrep -P`
			// still see the same children. Walk the whole pid table via
			// `proc_listallpids` and filter on `pbi_ppid` instead; this is the
			// same approach we already use for `find_by_path` and that the
			// Windows implementation uses via Toolhelp snapshots.
			let tree = build_process_tree();
			self.children_from_tree(&tree)
		}

		pub fn parent_pid(&self) -> Option<i32> {
			let info = self.live_bsdinfo()?;
			i32::try_from(info.pbi_ppid).ok().filter(|ppid| *ppid > 0)
		}

		pub fn args(&self) -> Vec<String> {
			if self.live_bsdinfo().is_none() {
				return Vec::new();
			}
			sys::args(self.pid)
		}

		pub fn kill(&self, signal: i32) -> bool {
			// Re-validate identity right before signaling. There is no atomic
			// "kill iff start_time matches" primitive on macOS, so a vanishingly
			// small window remains between this check and the syscall — but
			// matching against the recorded `(pid, start_tvsec, start_tvusec)`
			// triple eliminates the PID-reuse race in every practical case.
			if self.live_bsdinfo().is_none() {
				return false;
			}
			// SAFETY: `kill` takes integer identifiers by value and does not
			// access caller-owned memory.
			unsafe { libc::kill(self.pid, signal) == 0 }
		}

		pub fn group_id(&self) -> Option<i32> {
			let info = self.live_bsdinfo()?;
			i32::try_from(info.pbi_pgid).ok()
		}

		/// Walk the descendant tree in post-order (leaves first), de-duplicating
		/// by PID so concurrent reparenting cannot trap us in a cycle.
		pub fn descendants(&self) -> Vec<Self> {
			if self.live_bsdinfo().is_none() {
				return Vec::new();
			}
			// One process-table snapshot per walk — building it inside the
			// recursion would re-scan every pid for every visited node,
			// producing an `O(N · D)` kernel call pattern. Mirrors the Windows
			// implementation.
			let tree = build_process_tree();
			let mut out = Vec::new();
			let mut visited = HashSet::new();
			visited.insert(self.pid);
			self.collect_descendants_from_tree(&tree, &mut visited, &mut out);
			out
		}

		fn children_from_tree(&self, tree: &HashMap<i32, Vec<i32>>) -> Vec<Self> {
			let Some(child_pids) = tree.get(&self.pid) else {
				return Vec::new();
			};
			child_pids
				.iter()
				.filter_map(|&pid| {
					let child = Self::from_pid(pid)?;
					(child.parent_pid() == Some(self.pid) && self.live_bsdinfo().is_some())
						.then_some(child)
				})
				.collect()
		}

		fn collect_descendants_from_tree(
			&self,
			tree: &HashMap<i32, Vec<i32>>,
			visited: &mut HashSet<i32>,
			out: &mut Vec<Self>,
		) {
			for child in self.children_from_tree(tree) {
				let child_pid = child.pid;
				if !visited.insert(child_pid) {
					continue;
				}
				// Post-order: grandchildren first, so leaf processes get signalled
				// before their parents during tree termination.
				let subtree_start = out.len();
				child.collect_descendants_from_tree(tree, visited, out);
				if child.parent_pid() == Some(self.pid) && self.live_bsdinfo().is_some() {
					out.push(child);
				} else {
					out.truncate(subtree_start);
				}
			}
		}

		pub fn status(&self) -> ProcessStatus {
			if self.live_bsdinfo().is_some() {
				ProcessStatus::Running
			} else {
				ProcessStatus::Exited
			}
		}

		/// Resolves once the process exits, through a kqueue `NOTE_EXIT`
		/// filter.
		pub async fn exited(&self) -> std::io::Result<()> {
			use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};

			// SAFETY: `kqueue` takes no arguments; a negative result is an error.
			let kq = unsafe { libc::kqueue() };
			if kq < 0 {
				return Err(std::io::Error::last_os_error());
			}
			// SAFETY: `kq` is a fresh descriptor nothing else owns.
			let kq = unsafe { OwnedFd::from_raw_fd(kq) };
			// Scoped so the raw record (its `udata` is a `*mut c_void`) is gone
			// before the await below; holding it would make this future `!Send`.
			let registered = {
				let change = libc::kevent {
					ident: self.pid as libc::uintptr_t,
					filter: libc::EVFILT_PROC,
					flags: libc::EV_ADD | libc::EV_ONESHOT,
					fflags: libc::NOTE_EXIT,
					data: 0,
					udata: ptr::null_mut(),
				};
				// SAFETY: `change` is one initialized change record; with no event
				// buffer the call only registers it and the null timeout is unused.
				unsafe {
					libc::kevent(kq.as_raw_fd(), &raw const change, 1, ptr::null_mut(), 0, ptr::null())
				}
			};
			if registered < 0 {
				let err = std::io::Error::last_os_error();
				// No such process: it is already gone.
				return if err.raw_os_error() == Some(libc::ESRCH) {
					Ok(())
				} else {
					Err(err)
				};
			}
			// The pid may have been reused before the filter was registered, in
			// which case it watches another process; confirm identity after.
			if self.status() != ProcessStatus::Running {
				return Ok(());
			}
			let kq = tokio::io::unix::AsyncFd::with_interest(kq, tokio::io::Interest::READABLE)?;
			let _ready = kq.readable().await?;
			Ok(())
		}

		/// Returns the current `proc_bsdinfo` only if it still describes the same
		/// process this reference was opened on — i.e. the start time has not
		/// changed.
		fn live_bsdinfo(&self) -> Option<libc::proc_bsdinfo> {
			let info = sys::bsdinfo(self.pid)?;
			if info.pbi_start_tvsec == self.start_tvsec && info.pbi_start_tvusec == self.start_tvusec {
				Some(info)
			} else {
				None
			}
		}

		#[cfg(test)]
		pub(super) fn with_stale_identity(&self) -> Self {
			Self { start_tvusec: self.start_tvusec ^ 1, ..self.clone() }
		}
	}

	#[cfg(test)]
	mod tests {
		use super::*;

		#[test]
		fn snapshot_revalidates_child_parentage() {
			// A stale/cyclic snapshot must not make a process its own child.
			// This test only reads identities; no process is ever signalled.
			let pid = i32::try_from(std::process::id()).expect("self pid");
			let root = Process::from_pid(pid).expect("pin root");
			let tree = HashMap::from([(pid, vec![pid])]);
			assert!(root.children_from_tree(&tree).is_empty());
		}
	}

	/// Build a `ppid -> [pids]` map from a one-shot scan of `proc_listallpids`.
	///
	/// Used as the foundation of `Process::children` and `Process::descendants`
	/// on macOS where `proc_listchildpids` returns no children for self-queries.
	pub(super) fn build_process_tree() -> HashMap<i32, Vec<i32>> {
		let pids = sys::pids();
		let mut tree: HashMap<i32, Vec<i32>> = HashMap::with_capacity(pids.len() / 2);
		for pid in pids {
			let Some(info) = sys::bsdinfo(pid) else {
				continue;
			};
			let Ok(ppid) = i32::try_from(info.pbi_ppid) else {
				continue;
			};
			if ppid <= 0 {
				continue;
			}
			tree.entry(ppid).or_default().push(pid);
		}
		tree
	}

	/// Find processes whose libproc-reported executable path equals `target`.
	pub fn find_by_path(target: &str) -> Vec<Process> {
		let mut path = [0u8; sys::PATH_CAPACITY];
		sys::pids()
			.into_iter()
			.filter(|pid| *pid > 0 && sys::executable_path(*pid, &mut path) == Some(target.as_bytes()))
			.filter_map(Process::from_pid)
			.collect()
	}
}
#[cfg(target_os = "windows")]
mod platform {
	use std::{
		collections::{HashMap, HashSet},
		ffi::OsStr,
		os::windows::{ffi::OsStrExt, io::OwnedHandle},
		sync::Arc,
	};

	use pi_builtins::proc_sys as sys;
	use smallvec::SmallVec;

	use super::ProcessStatus;

	const PROCESS_REFERENCE_ACCESS: u32 =
		sys::PROCESS_TERMINATE | sys::PROCESS_QUERY_LIMITED_INFORMATION | sys::SYNCHRONIZE;

	#[derive(Clone)]
	/// Stable Windows process reference backed by an owned process handle plus
	/// the kernel-reported creation time, which pins identity even if the PID is
	/// recycled while we hold the handle.
	pub struct Process {
		pid:           i32,
		handle:        Arc<OwnedHandle>,
		creation_time: u64,
	}

	impl Process {
		pub fn from_pid(pid: i32) -> Option<Self> {
			if pid <= 0 {
				return None;
			}
			let handle =
				Arc::new(sys::open_process(u32::try_from(pid).ok()?, PROCESS_REFERENCE_ACCESS)?);
			let creation_time = sys::process_times(&handle)?.0;
			Some(Self { pid, handle, creation_time })
		}

		pub const fn pid(&self) -> i32 {
			self.pid
		}

		pub fn identity(&self) -> String {
			format!("windows:{}:{}", self.pid, self.creation_time)
		}

		pub fn parent_pid(&self) -> Option<i32> {
			sys::parent_pid(&self.handle)
		}

		/// Read through the pinned handle, so it is always this process's
		/// command line even after the pid is reused.
		pub fn args(&self) -> Vec<String> {
			sys::command_line(&self.handle)
				.map_or_default(|command_line| sys::split_command_line(&command_line))
		}

		pub fn children(&self) -> Vec<Self> {
			let tree = build_process_tree();
			self.children_from_tree(&tree)
		}

		/// Walk the entire descendant tree using a single Toolhelp snapshot.
		///
		/// `children()` recursing per-node would re-snapshot the whole process
		/// table for every visited descendant, making tree termination
		/// `O(N · D)` snapshots. One snapshot per termination wave is enough.
		pub fn descendants(&self) -> Vec<Self> {
			let tree = build_process_tree();
			let Ok(root) = u32::try_from(self.pid) else {
				return Vec::new();
			};
			let mut visited: HashSet<u32> = HashSet::new();
			visited.insert(root);
			let mut out = Vec::new();
			self.collect_descendants_from_tree(&tree, &mut visited, &mut out);
			out
		}

		/// The running process `child_pid`, when it really is a child of
		/// `self`. Windows never rewrites the parent id recorded for a process
		/// whose parent exited, so such an orphan is listed as a child of
		/// whichever process reuses that pid. A real child cannot have been
		/// created before its parent; an orphan older than `self` can.
		fn child(&self, child_pid: u32) -> Option<Self> {
			let child = Self::from_pid(i32::try_from(child_pid).ok()?)?;
			(child.creation_time >= self.creation_time && child.status() == ProcessStatus::Running)
				.then_some(child)
		}

		pub(super) fn children_from_tree(
			&self,
			tree: &HashMap<u32, SmallVec<[u32; 4]>>,
		) -> Vec<Self> {
			let Ok(pid_u32) = u32::try_from(self.pid) else {
				return Vec::new();
			};
			tree
				.get(&pid_u32)
				.into_iter()
				.flatten()
				.filter_map(|&child_pid| self.child(child_pid))
				.collect()
		}

		fn collect_descendants_from_tree(
			&self,
			tree: &HashMap<u32, SmallVec<[u32; 4]>>,
			visited: &mut HashSet<u32>,
			out: &mut Vec<Self>,
		) {
			let Some(children) = u32::try_from(self.pid).ok().and_then(|pid| tree.get(&pid)) else {
				return;
			};
			for &child_pid in children {
				if !visited.insert(child_pid) {
					continue;
				}
				let Some(child) = self.child(child_pid) else {
					continue;
				};
				// Post-order: collect grandchildren first so leaves are signalled
				// before their parents during tree termination.
				child.collect_descendants_from_tree(tree, visited, out);
				out.push(child);
			}
		}

		/// The handle pins the original kernel process object even after the
		/// pid is recycled, so this cannot hit a different process.
		pub fn kill(&self, _signal: i32) -> bool {
			sys::terminate(&self.handle)
		}

		pub const fn group_id() -> Option<i32> {
			None
		}

		pub fn status(&self) -> ProcessStatus {
			if sys::has_exited(&self.handle) {
				ProcessStatus::Exited
			} else {
				ProcessStatus::Running
			}
		}

		/// Resolves once the process exits, through a thread-pool wait on the
		/// process handle, so no thread is parked per waiter.
		pub async fn exited(&self) -> std::io::Result<()> {
			sys::exited(Arc::clone(&self.handle)).await
		}
	}

	/// Build a map of `parent_pid` -> [`child_pids`] for all processes.
	fn build_process_tree() -> HashMap<u32, SmallVec<[u32; 4]>> {
		let mut tree: HashMap<u32, SmallVec<[u32; 4]>> = HashMap::new();
		for entry in sys::processes() {
			tree.entry(entry.ppid).or_default().push(entry.pid);
		}
		tree
	}

	/// Find processes whose `QueryFullProcessImageNameW` result equals `target`.
	pub fn find_by_path(target: &str) -> Vec<Process> {
		let target: Vec<u16> = OsStr::new(target).encode_wide().collect();
		let mut path = vec![0u16; 32_768];
		sys::processes()
			.filter(|entry| {
				sys::open_process(entry.pid, sys::PROCESS_QUERY_LIMITED_INFORMATION)
					.is_some_and(|handle| sys::image_path(&handle, &mut path) == Some(&target[..]))
			})
			.filter_map(|entry| Process::from_pid(i32::try_from(entry.pid).ok()?))
			.collect()
	}
}

/// Stable process reference.
#[derive(Clone)]
pub struct Process {
	inner: platform::Process,
}

impl Process {
	/// Open a stable process reference from a PID.
	pub fn from_pid(pid: i32) -> Option<Self> {
		platform::Process::from_pid(pid).map(Self::from_inner)
	}

	/// Open stable process references whose executable path matches exactly.
	pub fn from_path(path: String) -> Vec<Self> {
		platform::find_by_path(&path)
			.into_iter()
			.map(Self::from_inner)
			.collect()
	}

	/// Operating-system process identifier for this process reference.
	#[must_use]
	pub const fn pid(&self) -> i32 {
		self.inner.pid()
	}

	/// Opaque identity of the pinned process instance, stable after exit.
	/// Includes OS boot/start identity; equality is not permission to signal.
	#[must_use]
	pub fn identity(&self) -> String {
		self.inner.identity()
	}

	/// Parent process id for this process, when available.
	#[must_use]
	pub fn ppid(&self) -> Option<i32> {
		self.inner.parent_pid()
	}

	/// Launch arguments for this process.
	#[must_use]
	pub fn args(&self) -> Vec<String> {
		self.inner.args()
	}

	/// Send `signal` to this process only, through its pinned identity, so it
	/// never reaches a process that reused the pid after this one was reaped.
	/// On Windows the process is terminated whatever `signal` is.
	pub fn signal(&self, signal: i32) -> bool {
		self.inner.kill(signal)
	}

	/// Send `signal` to this process and its descendants, children first.
	///
	/// On Linux and macOS the signal is forwarded as-is. On Windows there is no
	/// signal abstraction, so the `signal` argument is ignored and the entire
	/// tree is hard-killed via `TerminateProcess`. Defaults to the POSIX
	/// hard-kill signal.
	/// Refuses the host and, on Unix, its live ancestors (returns zero).
	#[must_use]
	pub fn kill_tree(&self, signal: Option<i32>) -> u32 {
		self.signal_tree(signal.unwrap_or(KILL_SIGNAL))
	}

	/// Process group id for this process, when supported by the platform.
	#[cfg(target_os = "windows")]
	#[must_use]
	pub const fn group_id(&self) -> Option<i32> {
		platform::Process::group_id()
	}

	#[cfg(not(target_os = "windows"))]
	#[must_use]
	pub fn group_id(&self) -> Option<i32> {
		self.inner.group_id().filter(|pgid| *pgid > 0)
	}

	/// Direct children of this process as stable process references.
	pub fn children(&self) -> Vec<Self> {
		self
			.inner
			.children()
			.into_iter()
			.map(Self::from_inner)
			.collect()
	}

	/// Current status of this process reference.
	#[must_use]
	pub fn status(&self) -> ProcessStatus {
		self.inner.status()
	}

	/// Gracefully terminate this process and its descendants.
	///
	/// Sends `TERM_SIGNAL` to the optional process group, every live descendant,
	/// and the root, then optionally waits up to `graceful_ms` for the tree to
	/// exit before escalating to `KILL_SIGNAL`. Pass `graceful_ms < 0` to skip
	/// the wait entirely (the polite signal is still emitted). Returns `true`
	/// when the tree has exited by the end of the hard wave's wait window.
	/// Refuses the host and, on Unix, its live ancestors (returns `false`).
	pub async fn terminate_tree(
		&self,
		group: bool,
		graceful_ms: i32,
		timeout_ms: u32,
		ct: CancelToken,
	) -> Result<bool> {
		self
			.terminate_tree_impl(group, graceful_ms, timeout_ms, ct)
			.await
	}

	/// Wait until this process exits, optionally bounded by `timeout`.
	pub async fn wait_for_exit(&self, timeout: Option<Duration>, ct: CancelToken) -> Result<bool> {
		wait_for_exit(self, &[], timeout, ct).await
	}
}

impl Process {
	const fn from_inner(inner: platform::Process) -> Self {
		Self { inner }
	}

	/// Walk the live descendant tree from scratch. Cheap and idempotent — call
	/// it again before each signal wave so grandchildren spawned during a grace
	/// period are not missed.
	fn live_descendants(&self) -> Vec<Self> {
		self
			.inner
			.descendants()
			.into_iter()
			.map(Self::from_inner)
			.collect()
	}

	fn signal_tree(&self, signal: i32) -> u32 {
		let Some(protection) = host_protection() else {
			return 0;
		};
		self.signal_tree_excluding(signal, &protection.pids)
	}

	/// Signal this process and its live descendants (children first), skipping
	/// any pid in `protected`.
	///
	/// `protected` shields the harness itself: a run-cancellation sweep must
	/// never hard-kill the host. On Windows the
	/// descendant tree is derived from raw `th32ParentProcessID` values that
	/// outlive their recorded parent, so a freshly spawned child whose recycled
	/// pid matches the harness's stale parent pid makes the harness enumerate
	/// as a false descendant; `TerminateProcess`-ing it drops the whole session
	/// with no cleanup and no `session_exit` record (#7452, related #4605).
	fn signal_tree_excluding(&self, signal: i32, protected: &HashSet<i32>) -> u32 {
		if protected.contains(&self.pid()) {
			return 0;
		}
		let descendants = self.signalable_descendants(protected);
		let mut signaled = 0u32;
		// If self leads its own process group, also signal the group — this
		// catches grandchildren reparented to init when their immediate parent
		// died inside the descendant walk.
		if let Some(pgid) = self.group_id()
			&& pgid == self.inner.pid()
		{
			let _ = kill_process_group(pgid, signal);
		}
		for child in &descendants {
			if child.inner.kill(signal) {
				signaled += 1;
			}
		}
		if self.inner.kill(signal) {
			signaled += 1;
		}
		signaled
	}

	/// Live descendants with every protected subtree pruned, not just the exact
	/// protected pids.
	///
	/// The flattened descendant list can contain a protected node (the harness,
	/// on a Windows PID-reuse false-descendant) *together with* that node's real
	/// children, which were collected by recursing through it. Skipping only the
	/// exact protected pid would still terminate those unrelated worker/tool
	/// subprocesses, so drop every node whose recorded parent chain — within the
	/// enumerated set — passes through a protected pid (#7452 review).
	fn signalable_descendants(&self, protected: &HashSet<i32>) -> Vec<Self> {
		let descendants = self.live_descendants();
		let parents: HashMap<i32, i32> = descendants
			.iter()
			.filter_map(|descendant| descendant.ppid().map(|parent| (descendant.pid(), parent)))
			.collect();
		descendants
			.into_iter()
			.filter(|descendant| !pid_in_protected_subtree(descendant.pid(), protected, &parents))
			.collect()
	}

	async fn terminate_tree_impl(
		&self,
		group: bool,
		graceful_ms: i32,
		timeout_ms: u32,
		ct: CancelToken,
	) -> Result<bool> {
		let Some(protection) = host_protection() else {
			return Ok(false);
		};
		let protected = protection.pids;
		if protected.contains(&self.pid()) {
			return Ok(false);
		}
		if self.status() != ProcessStatus::Running {
			return Ok(true);
		}

		// A root may authorize only its own group, never a group it merely joined.
		let process_group = if group {
			self.group_id().filter(|pgid| *pgid == self.pid())
		} else {
			None
		};
		// Capture ownership before TERM can reap the root and reparent its children.
		let mut descendants = self.signalable_descendants(&protected);

		// Polite wave: SIGTERM the group, every live descendant, then the root.
		if let Some(pgid) = process_group
			&& self.group_id() == Some(pgid)
		{
			let _ = kill_process_group(pgid, TERM_SIGNAL);
		}
		for child in &descendants {
			let _ = child.inner.kill(TERM_SIGNAL);
		}
		if !protected.contains(&self.pid()) {
			let _ = self.inner.kill(TERM_SIGNAL);
		}

		// Optional grace wait. A negative `graceful_ms` skips the wait entirely
		// (we still emit the polite signal so cleanup handlers can run before
		// KILL).
		if graceful_ms >= 0 {
			let exited = wait_for_exit(
				self,
				&descendants,
				Some(Duration::from_millis(graceful_ms as u64)),
				ct.clone(),
			)
			.await?;
			if exited {
				return Ok(true);
			}
		}

		// Retain pinned survivors even if TERM reparented them away from the root.
		descendants.retain(|child| child.status() == ProcessStatus::Running);
		let mut seen: HashSet<i32> = descendants.iter().map(Self::pid).collect();
		descendants.extend(
			self
				.signalable_descendants(&protected)
				.into_iter()
				.filter(|child| seen.insert(child.pid())),
		);
		// A cached PGID alone is not ownership: a pinned member must still anchor it.
		if let Some(pgid) = process_group
			&& std::iter::once(self)
				.chain(&descendants)
				.any(|process| process.group_id() == Some(pgid))
		{
			let _ = kill_process_group(pgid, KILL_SIGNAL);
		}
		for child in &descendants {
			let _ = child.inner.kill(KILL_SIGNAL);
		}
		if !protected.contains(&self.pid()) {
			let _ = self.inner.kill(KILL_SIGNAL);
		}

		wait_for_exit(self, &descendants, Some(Duration::from_millis(u64::from(timeout_ms))), ct)
			.await
	}
}

/// Shared signal guard. Unix parentage is live and revalidated; Windows PPIDs
/// can refer to recycled processes, so only the host itself is protected there.
struct HostProtection {
	pids:   HashSet<i32>,
	#[cfg(unix)]
	groups: HashSet<i32>,
}

fn host_protection() -> Option<HostProtection> {
	let pid = i32::try_from(std::process::id()).ok()?;
	#[cfg(not(unix))]
	{
		Some(HostProtection { pids: HashSet::from([pid]) })
	}
	#[cfg(unix)]
	{
		let mut protection = HostProtection { pids: HashSet::new(), groups: HashSet::new() };
		let mut process = Process::from_pid(pid)?;
		// A failed read, unstable parentage, or cycle cannot authorize a signal.
		for _ in 0..256 {
			if !protection.pids.insert(process.pid()) {
				return None;
			}
			// Kernel PGID 0 (e.g. macOS launchd) is valid ancestry metadata, but
			// never a public signal target. Keep it distinct from a failed query.
			protection.groups.insert(process.inner.group_id()?);
			if process.pid() == 1 {
				return Some(protection);
			}
			let parent_pid = process.ppid()?;
			if parent_pid == 1 {
				// PID 1 is the non-recyclable kernel init boundary. macOS may
				// deny libproc access to launchd, so it cannot require from_pid.
				// Only a revalidated live parent link authorizes this boundary.
				// SAFETY: getpgid reads scalar metadata for reserved kernel PID 1.
				let init_group = unsafe { libc::getpgid(1) };
				if init_group < 0 || process.ppid() != Some(1) {
					return None;
				}
				protection.pids.insert(1);
				protection.groups.insert(init_group);
				return Some(protection);
			}
			let parent = Process::from_pid(parent_pid)?;
			if process.ppid() != Some(parent.pid()) || parent.status() != ProcessStatus::Running {
				return None;
			}
			process = parent;
		}
		None
	}
}

/// True when `pid` is itself protected or descends — within the enumerated
/// `parents` map (pid -> recorded parent pid) — from a protected pid. Used to
/// prune a whole protected subtree from a cancellation sweep so a false
/// descendant of the harness cannot drag the harness's real children into the
/// kill set (#7452).
fn pid_in_protected_subtree(
	pid: i32,
	protected: &HashSet<i32>,
	parents: &HashMap<i32, i32>,
) -> bool {
	let mut current = pid;
	// Bound the walk against a corrupted or cyclic parent chain.
	for _ in 0..256 {
		if protected.contains(&current) {
			return true;
		}
		match parents.get(&current) {
			Some(&parent) if parent != current => current = parent,
			_ => return false,
		}
	}
	false
}

async fn wait_for_exit(
	root: &Process,
	descendants: &[Process],
	timeout: Option<Duration>,
	ct: CancelToken,
) -> Result<bool> {
	ct.heartbeat()?;
	if root.status() != ProcessStatus::Running
		&& descendants
			.iter()
			.all(|process| process.status() != ProcessStatus::Running)
	{
		return Ok(true);
	}

	// A lone process is awaited through the OS exit notification. Polling woke
	// every waiter 20 times a second, and IPC workers wait on their parent for
	// their whole life. Trees still poll: their membership changes.
	if descendants.is_empty()
		&& let Some(result) = wait_for_root_exit(root, timeout, &ct).await
	{
		return result;
	}

	let poll_interval = Duration::from_millis(50);
	let mut elapsed = Duration::ZERO;
	while timeout.is_none_or(|limit| elapsed < limit) {
		let sleep_for =
			timeout.map_or(poll_interval, |limit| limit.saturating_sub(elapsed).min(poll_interval));
		if sleep_for.is_zero() {
			break;
		}
		ct.heartbeat()?;
		tokio::time::sleep(sleep_for).await;
		elapsed += sleep_for;

		if root.status() != ProcessStatus::Running
			&& descendants
				.iter()
				.all(|process| process.status() != ProcessStatus::Running)
		{
			return Ok(true);
		}
	}

	Ok(false)
}

/// Waits for `root` to exit through the platform's exit notification:
/// `Ok(true)` once it exited, `Ok(false)` when `timeout` elapsed first.
/// `None` when no notification could be set up, so the caller polls instead.
async fn wait_for_root_exit(
	root: &Process,
	timeout: Option<Duration>,
	ct: &CancelToken,
) -> Option<Result<bool>> {
	let exited = root.inner.exited();
	let bounded = async {
		match timeout {
			Some(limit) => tokio::time::timeout(limit, exited).await.ok(),
			None => Some(exited.await),
		}
	};
	tokio::select! {
		outcome = bounded => match outcome {
			None => Some(Ok(false)),
			Some(Ok(())) => Some(Ok(true)),
			Some(Err(_)) => None,
		},
		reason = ct.wait() => Some(Err(anyhow::Error::msg(format!("Aborted: {reason:?}")))),
	}
}

/// Send `signal` to the process group `pgid`.
/// Returns false for invalid groups, host/Unix ancestor groups, unavailable
/// ancestry, or platforms without process groups.
#[allow(clippy::missing_const_for_fn, reason = "Dispatches to platform-specific implementation")]
#[must_use]
pub fn kill_process_group(pgid: i32, signal: i32) -> bool {
	if pgid <= 0 || is_protected_process_group(pgid) {
		return false;
	}
	platform_kill_process_group(pgid, signal)
}

#[cfg(unix)]
fn platform_kill_process_group(pgid: i32, signal: i32) -> bool {
	// SAFETY: `kill` takes integer identifiers by value and does not access
	// caller-owned memory. A negative PID is the POSIX process-group form.
	unsafe { libc::kill(-pgid, signal) == 0 }
}

/// Process groups are not exposed on Windows.
#[cfg(not(unix))]
const fn platform_kill_process_group(_pgid: i32, _signal: i32) -> bool {
	false
}

#[cfg(unix)]
fn is_protected_process_group(pgid: i32) -> bool {
	host_protection().is_none_or(|protection| protection.groups.contains(&pgid))
}

#[cfg(not(unix))]
const fn is_protected_process_group(_pgid: i32) -> bool {
	false
}

/// POSIX `SIGTERM` / Windows polite termination sentinel.
pub const TERM_SIGNAL: i32 = 15;

/// POSIX `SIGKILL` / Windows hard-termination sentinel.
pub const KILL_SIGNAL: i32 = 9;

/// Spawn-pinned process trees scheduled for termination together.
///
/// Wave snapshots share their pinned descendants with the spawn registry, so
/// reparenting after TERM cannot erase the ownership needed for KILL.
#[derive(Default)]
pub struct TerminationTargets {
	spawned: Vec<Arc<Mutex<SpawnedProcess>>>,
}

impl TerminationTargets {
	/// Create an empty target set.
	#[must_use]
	pub fn new() -> Self {
		Self::default()
	}

	/// Record a process handle captured at spawn, never a rediscovered PID.
	/// Only a pinned group leader can authorize group-wide signals.
	pub fn add_process(&mut self, process: Process) {
		if self.spawned.iter().any(|entry| {
			entry.lock().process.as_ref().is_some_and(|pinned| {
				pinned.pid() == process.pid() && pinned.status() == ProcessStatus::Running
			})
		}) {
			return;
		}
		let pgid = process.group_id().filter(|pgid| *pgid == process.pid());
		self
			.spawned
			.push(Arc::new(Mutex::new(SpawnedProcess::new(pgid, Some(process)))));
	}

	/// True when no targets have been recorded.
	#[must_use]
	pub const fn is_empty(&self) -> bool {
		self.spawned.is_empty()
	}

	/// Send a best-effort signal wave, retaining every pinned survivor.
	/// Unproven group metadata stays unresolved, but never grants authority.
	pub fn signal(&self, signal: i32) {
		let Some(protection) = host_protection() else {
			return;
		};
		// Pin all known trees before any group signal can kill their roots.
		for entry in &self.spawned {
			entry.lock().capture_descendants(&protection.pids);
		}
		for entry in &self.spawned {
			let entry = entry.lock();
			if entry.group_owned
				&& let Some(pgid) = entry.pgid
				&& entry
					.pinned()
					.any(|process| process.group_id() == Some(pgid))
			{
				let _ = kill_process_group(pgid, signal);
			}
			for process in entry.descendants.iter().chain(entry.process.iter()) {
				if !protection.pids.contains(&process.pid()) {
					let _ = process.inner.kill(signal);
				}
			}
		}
	}
}

/// A single external child reported by the shell's spawn-observer hook.
///
/// `process` is captured *at spawn time* so its OS-level identity is pinned
/// before the pid can be recycled. On Windows an open process handle keeps
/// the pid reserved for the lifetime of the reference; on Linux the pidfd
/// pins identity; on macOS the recorded `(pid, start_time)` triple detects
/// impersonation. Storing only the raw pid and re-opening at cancellation
/// time — as previous versions did — leaked kills onto unrelated processes
/// that happened to acquire the recycled pid between the child exiting and
/// the run being cancelled (issue #4605).
struct SpawnedProcess {
	process:     Option<Process>,
	pgid:        Option<i32>,
	group_owned: bool,
	descendants: Vec<Process>,
}

impl SpawnedProcess {
	fn new(pgid: Option<i32>, process: Option<Process>) -> Self {
		let pgid = pgid.filter(|pgid| *pgid > 0);
		let group_owned = process
			.as_ref()
			.is_some_and(|process| pgid == Some(process.pid()) && process.group_id() == pgid);
		Self { process, pgid, group_owned, descendants: Vec::new() }
	}

	fn pinned(&self) -> impl Iterator<Item = &Process> {
		self.process.iter().chain(&self.descendants)
	}

	fn capture_descendants(&mut self, protected: &HashSet<i32>) {
		self
			.descendants
			.retain(|process| process.status() == ProcessStatus::Running);
		let mut seen: HashSet<i32> = self.pinned().map(Process::pid).collect();
		let mut discovered = Vec::new();
		let mut scanned = HashSet::new();
		for process in self.pinned() {
			if !protected.contains(&process.pid()) && scanned.insert(process.pid()) {
				for child in process.signalable_descendants(protected) {
					scanned.insert(child.pid());
					if seen.insert(child.pid()) {
						discovered.push(child);
					}
				}
			}
		}
		self.descendants.extend(discovered);
		// Once every pinned anchor is gone, a reused PGID cannot restore
		// ownership. Keep the metadata only for unresolved-resource tracking.
		self.group_owned = self.group_owned
			&& self.pgid.is_some_and(|pgid| {
				self
					.pinned()
					.any(|process| process.group_id() == Some(pgid))
			});
	}
}

/// Per-run record of the OS processes a single shell command launched,
/// captured at spawn time via brush's `SpawnObserver` hook.
///
/// Replaces the old process-global "new descendants since a baseline" diff,
/// which could not distinguish the children of concurrent runs sharing one
/// host process: a run that cancelled would signal *any* descendant spawned
/// after its baseline, including another run's children. Ownership is now
/// explicit — only processes this run actually spawned are ever signalled.
#[derive(Default)]
struct RegistryState {
	spawned:       Vec<Arc<Mutex<SpawnedProcess>>>,
	/// The next `spawned.len()` at which `record` runs a sweep. Bounds sweep
	/// frequency when the live set stabilizes above the initial threshold:
	/// without this watermark, every subsequent `record` would find
	/// `len >= PRUNE_THRESHOLD` true and sweep on every spawn (O(n²) in a
	/// large-fan-out run like `for i in {1..1000}; do sleep 60 & done`). With
	/// it, the next sweep only fires once the vec has grown by another
	/// `PRUNE_THRESHOLD` entries since the previous sweep — restoring true
	/// amortized O(1) per spawn regardless of how many entries survive each
	/// sweep.
	next_sweep_at: usize,
}

#[derive(Default)]
pub struct SpawnRegistry {
	state: Mutex<RegistryState>,
}

impl SpawnRegistry {
	/// Amortized-cost threshold for opportunistic pruning of exited entries.
	///
	/// A shell run that spawns many short-lived external commands (e.g. a bash
	/// loop invoking a binary per iteration) would otherwise retain one owned
	/// process handle per spawn — a pidfd on Linux, a `HANDLE` on Windows — for
	/// the lifetime of the run, exhausting per-process FD/handle limits.
	///
	/// Each sweep costs `O(N)` (one non-blocking status probe per entry, plus
	/// a Toolhelp descendant walk on Windows for exited roots). The next sweep
	/// is scheduled `PRUNE_THRESHOLD` further records away — via the
	/// `next_sweep_at` watermark — so a run that keeps many concurrent
	/// long-lived children (`for i in {1..1000}; do sleep 60 & done`) does not
	/// sweep on every spawn just because the vec is already above threshold.
	/// Amortized cost per spawn stays `O(1)` regardless of the live-set size.
	const PRUNE_THRESHOLD: usize = 64;

	/// Create an empty registry.
	#[must_use]
	pub fn new() -> Self {
		Self::default()
	}

	/// Record a freshly spawned child. Called from the spawn-observer hook.
	///
	/// The `Process` handle MUST be opened by the caller *immediately* after
	/// the child's pid becomes visible, so identity is pinned before any race
	/// with pid recycling can start. A failed pin never authorizes a signal;
	/// any still-live observed group remains tracked as unresolved instead.
	///
	/// Exited entries are swept opportunistically once the recorded vec
	/// crosses the next-sweep watermark, so long-running loops of short
	/// external commands cannot exhaust the process' FD/handle limit by
	/// retaining one owned handle per historical spawn.
	pub fn record(&self, pgid: Option<i32>, process: Option<Process>) {
		let mut state = self.state.lock();
		state
			.spawned
			.push(Arc::new(Mutex::new(SpawnedProcess::new(pgid, process))));
		if state.spawned.len() >= state.next_sweep_at.max(Self::PRUNE_THRESHOLD) {
			prune_exited(&mut state.spawned);
			// Schedule the next sweep `PRUNE_THRESHOLD` further records away.
			// Comparing against the post-sweep live-set size (not the pre-sweep
			// length) bounds the sweep frequency when many entries survive:
			// each sweep costs O(N) but now runs at most once per
			// `PRUNE_THRESHOLD` records, so amortized per-record cost is O(1)
			// even if the live set stays large.
			state.next_sweep_at = state.spawned.len() + Self::PRUNE_THRESHOLD;
		}
	}

	/// Pids of recorded processes that are still alive, in spawn order.
	///
	/// Liveness is probed through each entry's pinned [`Process`] (pidfd on
	/// Linux, start-time identity on macOS, open handle on Windows), so a
	/// recycled pid never reports as one of this run's children. Entries whose
	/// pin failed at spawn time are skipped — they already exited. The
	/// recorded set is not mutated; pruning stays with `record`/`build_targets`.
	#[must_use]
	pub fn live_pids(&self) -> Vec<i32> {
		let state = self.state.lock();
		state
			.spawned
			.iter()
			.filter_map(|entry| entry.process.as_ref())
			.filter(|process| process.status() == ProcessStatus::Running)
			.map(Process::pid)
			.collect()
	}

	/// Build the kill set from the processes recorded so far. Re-read on every
	/// signal wave so a child spawned during a grace window — between the
	/// cancel firing and the next wave — is still reaped.
	///
	/// Pinned descendants are shared between snapshots and retained across
	/// waves. A bare live PGID keeps an entry unresolved, never signalable.
	///
	/// Pruning also runs here so a cancellation cycle sees a compact target
	/// set even when the record-time threshold hasn't fired yet.
	#[must_use]
	pub fn build_targets(&self) -> TerminationTargets {
		let mut state = self.state.lock();
		prune_exited(&mut state.spawned);
		state.next_sweep_at = state.spawned.len() + Self::PRUNE_THRESHOLD;
		TerminationTargets { spawned: state.spawned.clone() }
	}
}

/// Drop only resolved entries. A live numeric group is evidence of an
/// unresolved resource, not evidence of ownership. Retained descendant handles
/// survive root exit and can still authorize their own individual signals.
fn prune_exited(spawned: &mut Vec<Arc<Mutex<SpawnedProcess>>>) {
	spawned.retain(|entry| {
		let entry = entry.lock();
		if entry
			.pinned()
			.any(|process| process.status() == ProcessStatus::Running)
		{
			return true;
		}
		// Windows keeps the exited root's PID reserved through its handle.
		#[cfg(target_os = "windows")]
		if entry
			.pinned()
			.any(|process| !process.live_descendants().is_empty())
		{
			return true;
		}
		entry.pgid.is_some_and(process_group_alive)
	});
}

/// True when process group `pgid` still has at least one member. `kill(2)`
/// with signal 0 performs permission/existence checks without delivering a
/// signal; `EPERM` means the group exists but is not ours to signal, which
/// still counts as alive.
#[must_use]
#[allow(
	clippy::missing_const_for_fn,
	reason = "calls non-const platform_process_group_alive on unix"
)]
fn process_group_alive(pgid: i32) -> bool {
	if pgid <= 0 {
		return false;
	}
	platform_process_group_alive(pgid)
}

#[cfg(unix)]
fn platform_process_group_alive(pgid: i32) -> bool {
	// SAFETY: `kill` takes integer identifiers by value and does not access
	// caller-owned memory. A negative pid targets the process group; signal 0
	// only runs the existence/permission checks.
	let ret = unsafe { libc::kill(-pgid, 0) };
	ret == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

#[cfg(not(unix))]
const fn platform_process_group_alive(_pgid: i32) -> bool {
	false
}

#[cfg(test)]
mod tests {
	use super::*;

	/// The harness pid must be the only protected pid. Including its recorded
	/// parent would be unsafe on Windows: that stale numeric pid can have been
	/// recycled onto the timed-out command, causing cancellation to spare the
	/// hung target and its whole subtree.
	#[cfg(windows)]
	#[test]
	fn host_protected_pids_includes_self() {
		let self_pid = i32::try_from(std::process::id()).expect("self pid fits in i32");
		assert_eq!(
			host_protection().expect("host protection").pids,
			HashSet::from([self_pid]),
			"Windows must not protect recycled raw parent PIDs",
		);
	}

	/// Regression test for the #7453 review: pruning a protected node must drop
	/// its whole subtree, not just the exact protected pid. A Windows PID-reuse
	/// false-descendant collects the harness together with the harness's real
	/// children (LSP servers, worker/tool subprocesses); skipping only the host
	/// pid would still terminate those. `pid_in_protected_subtree` walks the
	/// enumerated parent map so any node under a protected pid is excluded.
	#[test]
	fn protected_subtree_is_pruned_not_just_the_pid() {
		// root(1) -> host(2, protected) -> worker(3); root(1) -> real_child(4).
		let parents: HashMap<i32, i32> = HashMap::from([(2, 1), (3, 2), (4, 1)]);
		let protected: HashSet<i32> = HashSet::from([2]);

		assert!(
			pid_in_protected_subtree(2, &protected, &parents),
			"the protected node itself must be excluded",
		);
		assert!(
			pid_in_protected_subtree(3, &protected, &parents),
			"a child collected through the protected node must be excluded too",
		);
		assert!(
			!pid_in_protected_subtree(4, &protected, &parents),
			"a real child of the sweep root must still be signalled",
		);
		assert!(
			!pid_in_protected_subtree(1, &protected, &parents),
			"the sweep root must not be pruned",
		);
	}

	/// Windows keeps the parent pid an orphan recorded, so after its parent
	/// exits the orphan is listed under whichever later process reuses that
	/// pid. The walk must not adopt it: an older process cannot be the child of
	/// a newer one, and a cancellation sweep would otherwise terminate an
	/// unrelated program.
	#[cfg(windows)]
	#[test]
	fn descendant_walk_skips_processes_older_than_their_listed_parent() {
		use std::{process::Command, thread, time::Duration};

		let spawn = || {
			Command::new("ping")
				.args(["-n", "30", "127.0.0.1"])
				.stdout(std::process::Stdio::null())
				.spawn()
				.expect("spawn sleeper")
		};
		let mut older = spawn();
		// Creation times have coarse granularity; keep the two apart.
		thread::sleep(Duration::from_millis(50));
		let mut newer = spawn();
		let (older_pid, newer_pid) = (older.id(), newer.id());
		let pin = |pid: u32| platform::Process::from_pid(i32::try_from(pid).unwrap()).unwrap();

		// A snapshot in which the older process names the newer one as its
		// parent, as it would after its own parent exited and the pid was reused.
		let tree = HashMap::from([(newer_pid, smallvec::SmallVec::from_slice(&[older_pid]))]);
		assert!(
			pin(newer_pid).children_from_tree(&tree).is_empty(),
			"an older process is not a child"
		);

		// The same entry is accepted when the listed child is newer.
		let tree = HashMap::from([(older_pid, smallvec::SmallVec::from_slice(&[newer_pid]))]);
		let children = pin(older_pid).children_from_tree(&tree);
		assert_eq!(
			children
				.iter()
				.map(platform::Process::pid)
				.collect::<Vec<_>>(),
			[i32::try_from(newer_pid).unwrap()]
		);

		let _ = older.kill();
		let _ = newer.kill();
		let _ = older.wait();
		let _ = newer.wait();
	}

	/// All real signal probes run behind an observed setsid + GO handshake.
	/// Even a guard-free RED can only kill disposable processes, never this
	/// runner.
	#[cfg(unix)]
	#[test]
	fn process_safety_isolated_regressions() {
		for mode in [
			"self-group",
			"zero-group",
			"protected-root",
			"ancestor-kill",
			"ancestor-term",
			"ancestor-term-group",
			"ancestor-group",
			"sibling-group",
			"owned-child",
			"nonleader-group",
			"reparented-child",
			"registry-unpinned-group",
			"registry-stale-group",
			"registry-nonleader-group",
			"registry-unanchored-escalation",
			"registry-reparented-child",
			"targets-reparented-child",
		] {
			run_safety_probe(mode, None);
		}
		#[cfg(target_os = "macos")]
		run_safety_probe("stale-root", None);
	}

	#[cfg(unix)]
	struct DisposableChild(std::process::Child);

	#[cfg(unix)]
	impl Drop for DisposableChild {
		fn drop(&mut self) {
			// Owned, unreaped Child only; never reopen a numeric PID for cleanup.
			let _ = self.0.kill();
			let _ = self.0.wait();
		}
	}

	#[cfg(unix)]
	fn run_safety_probe(mode: &str, target: Option<i32>) {
		use std::{
			io::{BufRead, BufReader, Write},
			os::unix::process::CommandExt,
			process::{Command, Stdio},
		};
		let mut command = Command::new(std::env::current_exe().expect("test executable"));
		command
			.args(["--exact", "process::tests::process_safety_probe", "--ignored", "--nocapture"])
			.env("OMP_PROCESS_SAFETY_MODE", mode)
			.env("OMP_PROCESS_SAFETY_TARGET", target.unwrap_or(0).to_string())
			.stdin(Stdio::piped())
			.stdout(Stdio::piped())
			.stderr(Stdio::inherit());
		// SAFETY: only async-signal-safe syscalls run between fork and exec.
		unsafe {
			command.pre_exec(move || {
				let result = if target.is_none() {
					libc::setsid()
				} else {
					libc::setpgid(0, 0)
				};
				if result < 0 {
					Err(std::io::Error::last_os_error())
				} else {
					Ok(())
				}
			});
		}
		let mut child = DisposableChild(command.spawn().expect("spawn isolated probe"));
		let pid = i32::try_from(child.0.id()).expect("child pid");
		let mut output = BufReader::new(child.0.stdout.take().expect("probe stdout"));
		let mut line = String::new();
		loop {
			line.clear();
			assert!(output.read_line(&mut line).expect("probe handshake") > 0, "no READY: {mode}");
			if line.starts_with("OMP_PROCESS_READY ") {
				break;
			}
		}
		let reported: Vec<i32> = line
			.split_whitespace()
			.skip(1)
			.map(|part| part.parse().expect("numeric handshake"))
			.collect();
		// SAFETY: scalar, read-only process/session queries.
		let (pgid, sid, own_pgid, own_sid) =
			unsafe { (libc::getpgid(pid), libc::getsid(pid), libc::getpgrp(), libc::getsid(0)) };
		assert_eq!(reported, vec![pid, pgid, sid], "kernel must confirm handshake");
		assert_eq!(pgid, pid, "probe must lead a disposable group");
		assert_ne!(pgid, own_pgid, "runner group must never be a probe target");
		if target.is_none() {
			assert_eq!(sid, pid, "sandbox must lead its own session");
			assert_ne!(sid, own_sid, "runner session must remain outside sandbox");
		} else {
			assert_eq!(sid, own_sid, "nested probe must stay in disposable session");
			assert_eq!(own_sid, own_pgid, "only sandbox leader may launch ancestor probes");
		}
		child
			.0
			.stdin
			.as_mut()
			.expect("probe stdin")
			.write_all(b"GO\n")
			.expect("authorize probe");
		// Drain stdout before wait so libtest output cannot fill the pipe.
		let mut rest = String::new();
		std::io::Read::read_to_string(&mut output, &mut rest).expect("probe result");
		let status = child.0.wait().expect("reap probe");
		assert!(status.success(), "isolated probe {mode} failed: {status}\n{rest}");
	}

	#[cfg(unix)]
	fn disposable_sleep() -> DisposableChild {
		DisposableChild(
			std::process::Command::new("sleep")
				.arg("30")
				.spawn()
				.expect("spawn sentinel"),
		)
	}

	#[cfg(unix)]
	fn assert_sentinel_responds(child: &mut DisposableChild, output: &mut impl std::io::BufRead) {
		use std::io::Write;
		child
			.0
			.stdin
			.as_mut()
			.expect("sentinel stdin")
			.write_all(b"probe\n")
			.expect("probe sentinel");
		let mut reply = String::new();
		output.read_line(&mut reply).expect("sentinel response");
		assert_eq!(reply.trim(), "ALIVE", "unowned sentinel must still respond after signaling");
	}

	#[cfg(unix)]
	fn terminate_probe(process: &Process, group: bool) -> bool {
		tokio::runtime::Builder::new_current_thread()
			.enable_time()
			.build()
			.expect("runtime")
			.block_on(process.terminate_tree(group, -1, 1000, CancelToken::default()))
			.expect("terminate result")
	}

	#[cfg(unix)]
	#[test]
	#[ignore = "subprocess entrypoint; use process_safety_isolated_regressions"]
	fn process_safety_probe() {
		use std::io::Write;
		let Ok(mode) = std::env::var("OMP_PROCESS_SAFETY_MODE") else {
			return;
		};
		// No signal-based watchdog: it exits only this disposable process.
		std::thread::spawn(|| {
			std::thread::sleep(Duration::from_secs(10));
			std::process::exit(124);
		});
		// SAFETY: read-only queries of this disposable process.
		let (pid, pgid, sid) = unsafe { (libc::getpid(), libc::getpgrp(), libc::getsid(0)) };
		println!("\nOMP_PROCESS_READY {pid} {pgid} {sid}");
		std::io::stdout().flush().expect("flush READY");
		let mut go = String::new();
		std::io::stdin().read_line(&mut go).expect("read GO");
		assert_eq!(go, "GO\n", "no signals before controller confirms isolation");
		assert_eq!(pid, pgid);

		if mode == "detached-tree-root" {
			use std::{os::unix::process::CommandExt, process::Command};
			// SAFETY: scalar, read-only query; only our disposable controller may launch
			// this.
			assert_eq!(unsafe { libc::getppid() }, sid);
			assert_ne!(pid, sid, "tree fixture must stay inside the disposable session");
			let _worker = DisposableChild(
				Command::new("sh")
					.args(["-c", "trap '' TERM; echo $$; exec sleep 30"])
					.process_group(0)
					.spawn()
					.expect("spawn detached TERM-resistant worker"),
			);
			let mut hold = String::new();
			std::io::stdin()
				.read_line(&mut hold)
				.expect("hold tree root");
			return;
		}

		if let Some(operation) = mode.strip_prefix("worker-") {
			let target: i32 = std::env::var("OMP_PROCESS_SAFETY_TARGET")
				.expect("target")
				.parse()
				.expect("target pid");
			// SAFETY: read-only queries. Never use the external runner as target.
			let parent_pid = unsafe { libc::getppid() };
			assert_eq!(sid, parent_pid, "parent must be the disposable session leader");
			assert_ne!(pid, sid, "worker must have a separate group");
			let parent = Process::from_pid(parent_pid).expect("pin disposable parent");
			let root = Process::from_pid(target).expect("pin disposable target");
			if operation == "sibling-group" {
				assert_eq!(root.ppid(), Some(parent_pid));
				assert!(terminate_probe(&root, true), "own sibling target remains terminable");
			} else {
				assert_eq!(target, parent_pid, "only disposable parent may be targeted");
				match operation {
					"ancestor-kill" => assert_eq!(root.kill_tree(Some(KILL_SIGNAL)), 0),
					"ancestor-term" => assert!(!terminate_probe(&root, false)),
					"ancestor-term-group" => assert!(!terminate_probe(&root, true)),
					"ancestor-group" => assert!(!kill_process_group(sid, TERM_SIGNAL)),
					_ => panic!("unknown worker operation"),
				}
			}
			assert_eq!(parent.status(), ProcessStatus::Running, "disposable ancestor must survive");
			return;
		}

		assert_eq!(sid, pid, "only isolated session leader may run probes");
		let sentinel = disposable_sleep();
		let sentinel_ref = Process::from_pid(sentinel.0.id() as i32).expect("pin sentinel");
		let own = Process::from_pid(pid).expect("pin disposable leader");
		match mode.as_str() {
			"self-group" => assert!(!kill_process_group(pgid, TERM_SIGNAL)),
			"zero-group" => assert!(!kill_process_group(0, TERM_SIGNAL)),
			"protected-root" => {
				assert_eq!(own.signal_tree_excluding(KILL_SIGNAL, &HashSet::from([pid])), 0);
			},
			"ancestor-kill" | "ancestor-term" | "ancestor-term-group" | "ancestor-group" => {
				run_safety_probe(&format!("worker-{mode}"), Some(pid));
			},
			"sibling-group" => {
				let mut target = disposable_sleep();
				let target_pid = target.0.id() as i32;
				// Reap concurrently: macOS reports unreaped zombies as Running.
				let reaper = std::thread::spawn(move || target.0.wait().expect("reap sibling"));
				run_safety_probe("worker-sibling-group", Some(target_pid));
				assert!(!reaper.join().expect("sibling reaper").success());
			},
			"owned-child" => {
				let mut target = disposable_sleep();
				let pinned = Process::from_pid(target.0.id() as i32).expect("pin owned child");
				let identity = pinned.identity();
				assert_eq!(
					Process::from_pid(pinned.pid())
						.expect("reopen live child")
						.identity(),
					identity
				);
				assert_ne!(identity, sentinel_ref.identity());
				let reaper = std::thread::spawn(move || target.0.wait().expect("reap owned child"));
				assert!(terminate_probe(&pinned, true), "own child must remain terminable");
				let _ = reaper.join().expect("owned child reaper");
				assert_eq!(pinned.status(), ProcessStatus::Exited);
				assert_eq!(pinned.identity(), identity, "identity survives process exit");
			},
			"nonleader-group" | "registry-nonleader-group" => {
				use std::{os::unix::process::CommandExt, process::Command};
				let leader = DisposableChild(
					Command::new("sleep")
						.arg("30")
						.process_group(0)
						.spawn()
						.expect("spawn unrelated group leader"),
				);
				let leader_ref = Process::from_pid(leader.0.id() as i32).expect("pin group leader");
				let group = leader_ref.group_id().expect("group");
				assert_eq!(group, leader_ref.pid());
				assert_ne!(group, pgid);
				let peer = DisposableChild(
					Command::new("sleep")
						.arg("30")
						.process_group(group)
						.spawn()
						.expect("spawn group sentinel"),
				);
				let peer_ref = Process::from_pid(peer.0.id() as i32).expect("pin group sentinel");
				let mut target = DisposableChild(
					Command::new("sleep")
						.arg("30")
						.process_group(group)
						.spawn()
						.expect("spawn nonleader target"),
				);
				let pinned = Process::from_pid(target.0.id() as i32).expect("pin target");
				assert_eq!(pinned.group_id(), Some(group));
				assert_eq!(peer_ref.group_id(), Some(group));
				let reaper = std::thread::spawn(move || target.0.wait().expect("reap target"));
				if mode == "registry-nonleader-group" {
					let registry = SpawnRegistry::new();
					registry.record(Some(group), Some(pinned));
					registry.build_targets().signal(KILL_SIGNAL);
				} else {
					assert!(terminate_probe(&pinned, true));
				}
				let _ = reaper.join().expect("target reaper");
				assert_eq!(
					leader_ref.status(),
					ProcessStatus::Running,
					"nonleader cannot authorize group"
				);
				assert_eq!(
					peer_ref.status(),
					ProcessStatus::Running,
					"unrelated group member must survive"
				);
			},
			"registry-unpinned-group" | "registry-stale-group" => {
				use std::{
					io::{BufRead, BufReader},
					os::unix::process::CommandExt,
					process::{Command, Stdio},
				};
				let mut foreign = DisposableChild(
					Command::new("sh")
						.args(["-c", "echo READY; while read ignored; do echo ALIVE; done"])
						.process_group(0)
						.stdin(Stdio::piped())
						.stdout(Stdio::piped())
						.spawn()
						.expect("foreign group"),
				);
				let mut output = BufReader::new(foreign.0.stdout.take().expect("sentinel stdout"));
				let mut ready = String::new();
				output.read_line(&mut ready).expect("sentinel ready");
				assert_eq!(ready.trim(), "READY");
				let foreign_ref = Process::from_pid(foreign.0.id() as i32).expect("pin sentinel");
				let group = foreign_ref.group_id().expect("sentinel group");
				assert_eq!(group, foreign_ref.pid());
				assert_ne!(group, pgid);
				let stale = if mode == "registry-stale-group" {
					let mut original = disposable_sleep();
					let pinned = Process::from_pid(original.0.id() as i32).expect("pin original");
					original.0.kill().expect("end original owned child");
					original.0.wait().expect("reap original");
					assert_eq!(pinned.status(), ProcessStatus::Exited);
					Some(pinned)
				} else {
					None
				};
				let registry = SpawnRegistry::new();
				registry.record(Some(group), stale);
				for signal in [TERM_SIGNAL, KILL_SIGNAL] {
					let targets = registry.build_targets();
					assert!(!targets.is_empty(), "unproven live group must stay unresolved");
					targets.signal(signal);
					assert_sentinel_responds(&mut foreign, &mut output);
				}
			},
			"registry-unanchored-escalation" => {
				use std::{
					io::{BufRead, BufReader},
					os::unix::process::CommandExt,
					process::{Command, Stdio},
				};
				let mut leader = DisposableChild(
					Command::new("sleep")
						.arg("30")
						.process_group(0)
						.spawn()
						.expect("owned leader"),
				);
				let pinned = Process::from_pid(leader.0.id() as i32).expect("pin leader");
				let group = pinned.group_id().expect("owned group");
				assert_eq!(group, pinned.pid());
				assert_ne!(group, pgid);
				// This member is not a descendant and is never pinned in the registry.
				let mut peer = DisposableChild(
					Command::new("sh")
						.args(["-c", "trap '' TERM; echo READY; while read ignored; do echo ALIVE; done"])
						.process_group(group)
						.stdin(Stdio::piped())
						.stdout(Stdio::piped())
						.spawn()
						.expect("unowned group peer"),
				);
				let mut ready = String::new();
				let mut output = BufReader::new(peer.0.stdout.take().expect("peer stdout"));
				output.read_line(&mut ready).expect("peer ready");
				assert_eq!(ready.trim(), "READY");
				let registry = SpawnRegistry::new();
				registry.record(Some(group), Some(pinned));
				let targets = registry.build_targets();
				targets.signal(TERM_SIGNAL);
				leader.0.wait().expect("reap leader after TERM");
				targets.signal(KILL_SIGNAL);
				let retry = registry.build_targets();
				assert!(!retry.is_empty(), "unanchored group must remain unresolved");
				retry.signal(KILL_SIGNAL);
				assert_sentinel_responds(&mut peer, &mut output);
			},
			"registry-reparented-child" | "targets-reparented-child" => {
				use std::{
					io::{BufRead, BufReader},
					os::unix::process::CommandExt,
					process::{Command, Stdio},
				};
				let mut root = DisposableChild(
					Command::new(std::env::current_exe().expect("test executable"))
						.args([
							"--exact",
							"process::tests::process_safety_probe",
							"--ignored",
							"--nocapture",
						])
						.env("OMP_PROCESS_SAFETY_MODE", "detached-tree-root")
						.process_group(0)
						.stdin(Stdio::piped())
						.stdout(Stdio::piped())
						.spawn()
						.expect("spawn owned tree fixture"),
				);
				let pinned = Process::from_pid(root.0.id() as i32).expect("pin tree root");
				let mut output = BufReader::new(root.0.stdout.take().expect("fixture stdout"));
				let mut line = String::new();
				loop {
					line.clear();
					assert!(output.read_line(&mut line).expect("fixture handshake") > 0);
					if line.starts_with("OMP_PROCESS_READY ") {
						break;
					}
				}
				// Confirm nested isolation before allowing the worker to spawn.
				let reported: Vec<i32> = line
					.split_whitespace()
					.skip(1)
					.map(|part| part.parse().expect("numeric handshake"))
					.collect();
				// SAFETY: scalar, read-only session query.
				assert_eq!(unsafe { libc::getsid(pinned.pid()) }, sid);
				assert_eq!(pinned.group_id(), Some(pinned.pid()));
				assert_eq!(reported, vec![pinned.pid(), pinned.pid(), sid]);
				let mut input = root.0.stdin.take().expect("fixture stdin");
				input.write_all(b"GO\n").expect("release fixture");
				line.clear();
				output.read_line(&mut line).expect("worker READY");
				let child = Process::from_pid(line.trim().parse().expect("worker pid"))
					.expect("pin worker before root exit");
				assert_eq!(child.ppid(), Some(pinned.pid()));
				assert_eq!(child.group_id(), Some(child.pid()), "worker escaped root group");
				let registry = SpawnRegistry::new();
				let targets = if mode == "registry-reparented-child" {
					registry.record(pinned.group_id(), Some(pinned));
					registry.build_targets()
				} else {
					let mut targets = TerminationTargets::new();
					targets.add_process(pinned);
					targets
				};
				targets.signal(TERM_SIGNAL);
				root.0.wait().expect("reap fixture root after TERM");
				assert_eq!(child.status(), ProcessStatus::Running, "worker must resist TERM");
				if mode == "registry-reparented-child" {
					drop(targets);
					let retry = registry.build_targets();
					assert!(!retry.is_empty(), "registry must retain escaped pinned worker");
					retry.signal(KILL_SIGNAL);
				} else {
					targets.signal(KILL_SIGNAL);
				}
				let exited = tokio::runtime::Builder::new_current_thread()
					.enable_time()
					.build()
					.expect("runtime")
					.block_on(child.wait_for_exit(Some(Duration::from_secs(1)), CancelToken::default()))
					.expect("wait for worker");
				assert!(exited, "reparented worker must receive the retained KILL wave");
			},
			"reparented-child" => {
				use std::{
					io::{BufRead, BufReader},
					os::unix::process::CommandExt,
					process::{Command, Stdio},
				};
				// Child ignores TERM; root exits on TERM. Pin both before the first
				// wave, then require KILL to reach the reparented surviving child.
				let mut target = DisposableChild(
					Command::new("sh")
						.args([
							"-c",
							r#"trap 'exit 0' TERM; sh -c 'trap "" TERM; echo "$$"; exec sleep 30' & read ignored"#,
						])
						.process_group(0)
						.stdin(Stdio::piped())
						.stdout(Stdio::piped())
						.spawn()
						.expect("spawn owned tree"),
				);
				let pinned = Process::from_pid(target.0.id() as i32).expect("pin root");
				let mut child_pid = String::new();
				BufReader::new(target.0.stdout.take().expect("tree stdout"))
					.read_line(&mut child_pid)
					.expect("child READY");
				let child = Process::from_pid(child_pid.trim().parse().expect("child pid"))
					.expect("pin child before root exit");
				assert_eq!(child.ppid(), Some(pinned.pid()));
				assert_eq!(pinned.group_id(), Some(pinned.pid()));
				assert_eq!(child.group_id(), Some(pinned.pid()));
				// Child::wait closes its stdin; keep the pipe open so only TERM,
				// not the concurrent reaper, releases the root's read.
				let _root_stdin = target.0.stdin.take().expect("retain root stdin");
				let reaper = std::thread::spawn(move || target.0.wait().expect("reap root"));
				let terminated = tokio::runtime::Builder::new_current_thread()
					.enable_time()
					.build()
					.expect("runtime")
					.block_on(pinned.terminate_tree(true, 100, 1000, CancelToken::default()))
					.expect("terminate tree");
				let _ = reaper.join().expect("root reaper");
				assert!(terminated, "retained child must not escape cleanup when root exits");
				assert_eq!(child.status(), ProcessStatus::Exited);
			},
			#[cfg(target_os = "macos")]
			"stale-root" => {
				let stale = own.inner.with_stale_identity();
				assert!(stale.descendants().is_empty(), "expired root cannot enumerate new children");
				assert!(stale.children().is_empty());
			},
			_ => panic!("unknown probe mode"),
		}
		assert_eq!(sentinel_ref.status(), ProcessStatus::Running, "unrelated sentinel must survive");
	}

	/// Regression test for the macOS `proc_listchildpids` brokenness: on
	/// darwin 25.4+ the kernel returns no entries when a process queries its
	/// own children via that API, so `Process::descendants` produced an empty
	/// list and termination cleanup silently became a no-op. The replacement
	/// path scans `proc_listallpids` and groups by `pbi_ppid`, which actually
	/// works. Linux has always worked via `/proc`.
	#[cfg(unix)]
	#[test]
	fn descendants_includes_freshly_spawned_child() {
		use std::{process::Command, thread, time::Duration};

		let mut child = Command::new("sleep")
			.arg("10")
			.spawn()
			.expect("spawn sleep");
		let child_pid = i32::try_from(child.id()).expect("child pid fits in i32");

		let self_pid = i32::try_from(std::process::id()).expect("self pid fits in i32");
		let harness = Process::from_pid(self_pid).expect("harness Process ref");

		// Allow a few polling iterations so the kernel's process-table query
		// settles on a loaded host. proc_listallpids reflects newly forked pids
		// within milliseconds in practice; 1s is a comfortable upper bound.
		let mut found = false;
		for _ in 0..40 {
			if harness
				.live_descendants()
				.iter()
				.any(|descendant| descendant.pid() == child_pid)
			{
				found = true;
				break;
			}
			thread::sleep(Duration::from_millis(25));
		}

		let _ = child.kill();
		let _ = child.wait();

		assert!(
			found,
			"freshly spawned child pid {child_pid} must appear in `live_descendants` so the \
			 cancellation cleanup can reach it; this regressed on macOS when the walk relied on the \
			 broken `proc_listchildpids`",
		);
	}

	/// Regression test for the review on PR #4606: a long-running shell
	/// command that spawns many short-lived external processes must not
	/// retain one owned handle per historical spawn — that would exhaust
	/// per-process FD/handle limits (pidfd on Linux, `HANDLE` on Windows).
	/// The registry MUST prune dead entries once the recorded vec crosses
	/// the sweep threshold.
	#[cfg(unix)]
	#[test]
	fn spawn_registry_prunes_exited_entries() {
		use std::{thread, time::Duration};

		let registry = SpawnRegistry::new();

		// Fabricate many recorded-then-exited children by pinning ourselves,
		// pushing the entry, then immediately treating it as "dead" from the
		// registry's perspective. To simulate the exit without actually
		// killing the harness, use `Process::from_pid(1)` for a pid that
		// (on Linux) is init and never exits — but wrap the recording in a
		// pattern that guarantees `status()` returns Exited for the pruner:
		// spawn a tiny child, pin it, wait for exit, then record.
		for _ in 0..(SpawnRegistry::PRUNE_THRESHOLD * 2) {
			let mut child = std::process::Command::new("true")
				.spawn()
				.expect("spawn true");
			let pid = i32::try_from(child.id()).expect("child pid fits in i32");
			let pinned = Process::from_pid(pid);
			let _ = child.wait();
			// Give the kernel a moment to mark the pidfd readable so `status()`
			// reports Exited when the pruner probes.
			for _ in 0..20 {
				if pinned
					.as_ref()
					.is_some_and(|process| process.status() == ProcessStatus::Exited)
				{
					break;
				}
				thread::sleep(Duration::from_millis(5));
			}
			registry.record(None, pinned);
		}

		let retained = registry.state.lock().spawned.len();
		assert!(
			retained < SpawnRegistry::PRUNE_THRESHOLD,
			"pruning must bound retained entries below the sweep threshold once the pinned processes \
			 have exited; got {retained} retained (threshold {})",
			SpawnRegistry::PRUNE_THRESHOLD
		);

		// build_targets sees no live handles → empty target set, matching the
		// contract that fully-exited registries stop the wave loop early.
		let targets = registry.build_targets();
		assert!(targets.is_empty(), "registry of only-dead entries must produce an empty target set");
	}

	/// Regression test for the third review on PR #4606: once the recorded
	/// vec crosses `PRUNE_THRESHOLD`, subsequent `record` calls must NOT
	/// sweep on every spawn. Without the `next_sweep_at` watermark, a large
	/// fan-out run whose live children exceed the threshold turned every
	/// spawn into an O(N) status probe of the whole retained set.
	///
	/// The check reasons about the observable side effect: after N records
	/// past threshold with entries that CANNOT be pruned (all still live),
	/// the retained size grows monotonically by exactly N — no sweep runs
	/// have modified the vec in between. The direct signal of "did a sweep
	/// happen" is a stable pinned handle count across records.
	#[cfg(unix)]
	#[test]
	fn spawn_registry_watermark_bounds_sweep_frequency() {
		let self_pid = i32::try_from(std::process::id()).expect("self pid fits in i32");
		let registry = SpawnRegistry::new();

		// Fill past threshold with entries that are permanently alive
		// (pinning ourselves) so the pruner has nothing to remove.
		let fill = SpawnRegistry::PRUNE_THRESHOLD + 10;
		for _ in 0..fill {
			registry.record(None, Process::from_pid(self_pid));
		}
		let after_fill = registry.state.lock().spawned.len();
		assert_eq!(after_fill, fill, "live-only entries must not be pruned during warm-up");
		let watermark_after_fill = registry.state.lock().next_sweep_at;

		// Every additional record with a live entry must land in the vec
		// verbatim and — critically — NOT re-enter `prune_exited` until the
		// vec crosses the freshly scheduled watermark. If the guard were
		// still `len >= PRUNE_THRESHOLD` (pre-fix), a sweep would fire on
		// every one of these records.
		let extra = 20;
		for _ in 0..extra {
			registry.record(None, Process::from_pid(self_pid));
		}
		let after_extra = registry.state.lock().spawned.len();
		assert_eq!(
			after_extra,
			after_fill + extra,
			"records with live entries must accumulate without triggering per-spawn sweeps"
		);
		assert_eq!(
			registry.state.lock().next_sweep_at,
			watermark_after_fill,
			"watermark must not advance while the vec stays below it — otherwise a sweep ran"
		);
	}

	/// `wait_for_exit` on a lone process resolves when it exits, reports a
	/// timeout as `false`, and surfaces cancellation as an abort error.
	#[tokio::test(flavor = "multi_thread")]
	async fn wait_for_exit_resolves_times_out_and_aborts() {
		use std::process::Command;

		#[cfg(unix)]
		let mut child = Command::new("sleep")
			.arg("30")
			.spawn()
			.expect("spawn sleep");
		#[cfg(windows)]
		let mut child = Command::new("ping")
			.args(["-n", "30", "127.0.0.1"])
			.stdout(std::process::Stdio::null())
			.spawn()
			.expect("spawn sleeper");
		let process = Process::from_pid(i32::try_from(child.id()).unwrap()).expect("pin child");

		let waited = process
			.wait_for_exit(Some(Duration::from_millis(100)), CancelToken::default())
			.await
			.expect("bounded wait");
		assert!(!waited, "a running process times out");

		let aborted = process
			.wait_for_exit(None, CancelToken::new(Some(100)))
			.await
			.expect_err("an expired token aborts the wait");
		assert_eq!(aborted.to_string(), "Aborted: Timeout");

		let waiter = {
			let process = process.clone();
			tokio::spawn(async move {
				process
					.wait_for_exit(Some(Duration::from_secs(20)), CancelToken::default())
					.await
			})
		};
		tokio::time::sleep(Duration::from_millis(50)).await;
		child.kill().expect("kill child");
		let exited = tokio::time::timeout(Duration::from_secs(5), waiter)
			.await
			.expect("the wait ends promptly after exit")
			.expect("waiter task")
			.expect("wait result");
		assert!(exited, "exit resolves the wait");
		let _ = child.wait();
	}
}
