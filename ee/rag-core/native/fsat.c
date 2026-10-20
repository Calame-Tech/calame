// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Calame Tech inc. Licensed under the Business Source License 1.1.
// See ee/LICENSE.BUSL at the root of the ee/ directory for terms.

/*
 * calame-fsat — directory-fd-anchored file operations for fs-write.ts.
 *
 * Node's fs API only takes path strings, so a validated path can be re-resolved
 * differently by the kernel if a parent is swapped for a symlink in between
 * (TOCTOU). This helper performs the whole operation in ONE process with POSIX
 * *at() calls:
 *
 *   - the root is opened once (O_DIRECTORY | O_NOFOLLOW) and every path
 *     component below it is opened with openat(parentfd, name,
 *     O_DIRECTORY | O_NOFOLLOW): a symlink is never followed, and later renames
 *     of any ancestor cannot redirect us because we hold the directory objects
 *     by fd, not by name;
 *   - the temp file is created inside a staging directory
 *     (.calame-stage-<pid>-<random>) made with mkdirat(0700) in the target's
 *     parent and held open by fd. The temp fd is kept open and its dev/ino
 *     recorded. It is published with a kernel create-only rename for create
 *     and a kernel exchange for replace: renameatx_np(RENAME_EXCL / RENAME_SWAP)
 *     on macOS, renameat2(RENAME_NOREPLACE / RENAME_EXCHANGE) on Linux;
 *   - every name passed to a syscall is a SINGLE component relative to a held
 *     directory fd. Cleanup unlinks <tmpName> relative to the held staging fd
 *     (before closing it) and only when that entry is still our temp file by
 *     dev/ino; the staging dir is removed with unlinkat(parentfd, stageName,
 *     AT_REMOVEDIR) only when that name still is our staging dir. No path
 *     containing '/' is ever built.
 *
 * What this does NOT provide:
 *   - Holding a directory fd does not lock the directory: a concurrent process
 *     can still rename it or its entries. The guarantee is that no operation
 *     escapes the directory objects walked from the root.
 *   - The staging dir's 0700 mode does NOT protect against processes running as
 *     the same UID: they can rename, replace or delete its entries. Integrity
 *     against same-UID processes is out of scope. Such tampering is detected
 *     where possible (dev/ino checks); when it is detected AFTER the publish
 *     syscall, the helper reports `published_unverified` — the target name may
 *     already point at something we did not write. It never tries to "undo"
 *     (no rollback, no deletion of entries it did not create).
 *   - The replace compare-then-swap is not a multi-process CAS: a writer that
 *     changes the file between the last check and the swap can be overwritten
 *     (the swap then reports `published_unverified` if the inode changed).
 *
 * Protocol (argv, then stdin payload, then one reply on stdout):
 *   read    <root> <maxBytes> -- seg...                       -> "OK <size>\n" + bytes | "ERR <code>\n"
 *   create  <root> <newLen> <tmpName> -- seg...    stdin=new   -> "OK\n" | "ERR <code>\n"
 *   replace <root> <newLen> <oldLen> <tmpName> -- seg...
 *                                                  stdin=new||old -> "OK\n" | "ERR <code>\n"
 * replace may answer "ERR published_displaced_missing": our temp file is
 * verified at the target name but the exchange returned no old entry (see the
 * check after rename_exchange). fs-write.ts then re-reads the target.
 * `old` is the content the caller read and verified; replace re-checks it
 * against the file twice (before temp creation and right before the swap).
 */

#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>
#ifdef __linux__
#include <sys/syscall.h>
#ifndef RENAME_NOREPLACE
#define RENAME_NOREPLACE (1 << 0)
#endif
#ifndef RENAME_EXCHANGE
#define RENAME_EXCHANGE (1 << 1)
#endif
#endif

#define ABSOLUTE_MAX (2 * 1024 * 1024)

/* Per-operation staging state. Every name below is a single path component. */
static int g_parent_fd = -1;    /* dirfd of the target's parent (holds the stage dir) */
static int g_stage_fd = -1;     /* held fd of the staging directory */
static char g_stage_name[64];   /* ".calame-stage-<pid>-<random>" */
static dev_t g_stage_dev = 0;
static ino_t g_stage_ino = 0;
static int g_tmp_fd = -1;       /* held fd of the temp file */
static const char *g_tmp_name = NULL;
static dev_t g_tmp_dev = 0;
static ino_t g_tmp_ino = 0;

/* True when `name` (single component, not followed) in dirfd is dev/ino. */
static int entry_is(int dirfd, const char *name, dev_t dev, ino_t ino) {
  struct stat st;
  if (fstatat(dirfd, name, &st, AT_SYMLINK_NOFOLLOW) != 0) return 0;
  return st.st_dev == dev && st.st_ino == ino;
}

/*
 * Best-effort cleanup. Only removes what we can still identify as ours:
 *   - <tmpName> inside the HELD staging fd, if it still is our temp file;
 *   - the staging dir by its single-component name in the parent fd, if that
 *     name still is our staging dir (rmdir also refuses a non-empty dir, so a
 *     foreign/displaced entry inside it keeps it in place).
 * Unlinks happen before the fds are closed. Never deletes foreign entries.
 */
static void cleanup(void) {
  if (g_stage_fd >= 0) {
    if (g_tmp_name != NULL && g_tmp_fd >= 0 &&
        entry_is(g_stage_fd, g_tmp_name, g_tmp_dev, g_tmp_ino)) {
      unlinkat(g_stage_fd, g_tmp_name, 0);
    }
    if (g_parent_fd >= 0 && g_stage_name[0] != '\0' &&
        entry_is(g_parent_fd, g_stage_name, g_stage_dev, g_stage_ino)) {
      unlinkat(g_parent_fd, g_stage_name, AT_REMOVEDIR);
    }
    close(g_stage_fd);
    g_stage_fd = -1;
  }
  g_stage_name[0] = '\0';
  if (g_tmp_fd >= 0) {
    close(g_tmp_fd);
    g_tmp_fd = -1;
  }
  g_tmp_name = NULL;
}

static void fail(const char *code) {
  cleanup();
  printf("ERR %s\n", code);
  fflush(stdout);
  fflush(stderr);
  _exit(1);
}

#ifdef CALAME_FSAT_TEST_HOOKS
/* Test-only build: pause at named points so tests can swap the tree for real. */
#include <time.h>
static void hook(const char *name) {
  const char *dir = getenv("CALAME_FSAT_HOOK_DIR");
  if (dir == NULL) return;
  char path[PATH_MAX];
  /* Only armed hooks pause: tests create <name>.arm before starting the op. */
  snprintf(path, sizeof path, "%s/%s.arm", dir, name);
  if (access(path, F_OK) != 0) return;
  snprintf(path, sizeof path, "%s/%s.reached", dir, name);
  int f = open(path, O_WRONLY | O_CREAT | O_APPEND, 0644);
  if (f >= 0) {
    char line[32];
    int n = snprintf(line, sizeof line, "%d\n", (int)getpid());
    if (write(f, line, (size_t)n) < 0) { /* best effort */ }
    close(f);
  }
  snprintf(path, sizeof path, "%s/%s.go", dir, name);
  for (int i = 0; i < 20000; i++) {
    if (access(path, F_OK) == 0) return;
    struct timespec ts = {0, 1000000};
    nanosleep(&ts, NULL);
  }
  fail("io_error");
}
#else
#define hook(name) ((void)0)
#endif

static int open_root(const char *path) {
  int fd = open(path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (fd < 0) {
    struct stat st;
    if (lstat(path, &st) == 0 && S_ISLNK(st.st_mode)) fail("symlink_refused");
    fail("root_unavailable");
  }
  return fd;
}

static int open_child_dir(int parent, const char *name) {
  int fd = openat(parent, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (fd < 0) {
    struct stat st;
    if (fstatat(parent, name, &st, AT_SYMLINK_NOFOLLOW) != 0) {
      if (errno == ENOENT) fail("parent_missing");
      fail("io_error");
    }
    if (S_ISLNK(st.st_mode)) fail("symlink_refused");
    if (!S_ISDIR(st.st_mode)) fail("invalid_path");
    fail("io_error");
  }
  return fd;
}

/*
 * Kernel-enforced publish primitives, both relative to held directory fds.
 * create-only: fails with EEXIST when anything exists at the new name.
 * exchange:    atomically swaps the two names (both must exist).
 * A filesystem without support reports ENOTSUP/ENOSYS (macOS) or EINVAL
 * (Linux: flag not supported by this filesystem).
 */
static int rename_create_only(int olddirfd, const char *oldname, int newdirfd, const char *newname) {
#if defined(__APPLE__)
  return renameatx_np(olddirfd, oldname, newdirfd, newname, RENAME_EXCL);
#elif defined(__linux__) && defined(SYS_renameat2)
  return (int)syscall(SYS_renameat2, olddirfd, oldname, newdirfd, newname, RENAME_NOREPLACE);
#else
  errno = ENOSYS;
  return -1;
#endif
}

static int rename_exchange(int olddirfd, const char *oldname, int newdirfd, const char *newname) {
#if defined(__APPLE__)
  return renameatx_np(olddirfd, oldname, newdirfd, newname, RENAME_SWAP);
#elif defined(__linux__) && defined(SYS_renameat2)
  return (int)syscall(SYS_renameat2, olddirfd, oldname, newdirfd, newname, RENAME_EXCHANGE);
#else
  errno = ENOSYS;
  return -1;
#endif
}

static int unsupported_rename_errno(int e) {
#if defined(__linux__)
  return e == EINVAL || e == ENOSYS || e == ENOTSUP || e == EOPNOTSUPP;
#else
  return e == ENOTSUP || e == ENOSYS;
#endif
}

/* Random suffix for the staging dir name (uniqueness, not secrecy). */
static unsigned random_u32(void) {
#if defined(__APPLE__)
  return (unsigned)arc4random();
#else
  unsigned v = 0;
  if (getentropy(&v, sizeof v) != 0) fail("io_error");
  return v;
#endif
}

static long long mtime_ns(const struct stat *s) {
#ifdef __APPLE__
  return (long long)s->st_mtimespec.tv_sec * 1000000000LL + s->st_mtimespec.tv_nsec;
#else
  return (long long)s->st_mtim.tv_sec * 1000000000LL + s->st_mtim.tv_nsec;
#endif
}

/* Opens `name` under dirfd as a regular file, never following a symlink.
 * Returns -1 when it does not exist. */
static int open_regular(int dirfd, const char *name, struct stat *out) {
  struct stat l;
  if (fstatat(dirfd, name, &l, AT_SYMLINK_NOFOLLOW) != 0) {
    if (errno == ENOENT) return -1;
    fail("io_error");
  }
  if (S_ISLNK(l.st_mode)) fail("symlink_refused");
  if (!S_ISREG(l.st_mode)) fail("not_a_regular_file");
  int fd = openat(dirfd, name, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC);
  if (fd < 0) {
    if (errno == ENOENT) return -1;
    if (errno == ELOOP) fail("symlink_refused");
    fail("io_error");
  }
  if (fstat(fd, out) != 0) fail("io_error");
  if (!S_ISREG(out->st_mode)) fail("not_a_regular_file");
  if (out->st_ino != l.st_ino || out->st_dev != l.st_dev) fail("symlink_refused");
  return fd;
}

static size_t write_all_fd(int fd, const unsigned char *buf, size_t len) {
  size_t off = 0;
  while (off < len) {
    ssize_t n = write(fd, buf + off, len - off);
    if (n < 0) {
      if (errno == EINTR) continue;
      return off;
    }
    off += (size_t)n;
  }
  return off;
}

/* Reads the whole regular file; fails with too_large above `max`. */
static unsigned char *read_file(int fd, const struct stat *st, size_t max, size_t *len) {
  if ((unsigned long long)st->st_size > max) fail("too_large");
  size_t cap = (size_t)st->st_size + 1;
  unsigned char *buf = malloc(cap);
  if (buf == NULL) fail("io_error");
  size_t off = 0;
  for (;;) {
    if (off == cap) {
      if (cap > max) fail("too_large");
      cap *= 2;
      unsigned char *nb = realloc(buf, cap);
      if (nb == NULL) fail("io_error");
      buf = nb;
    }
    ssize_t n = read(fd, buf + off, cap - off);
    if (n < 0) {
      if (errno == EINTR) continue;
      fail("io_error");
    }
    if (n == 0) break;
    off += (size_t)n;
    if (off > max) fail("too_large");
  }
  *len = off;
  return buf;
}

static unsigned char *read_stdin(size_t len) {
  unsigned char *buf = malloc(len + 1);
  if (buf == NULL) fail("io_error");
  size_t off = 0;
  while (off < len) {
    ssize_t n = read(0, buf + off, len - off);
    if (n < 0) {
      if (errno == EINTR) continue;
      fail("io_error");
    }
    if (n == 0) fail("io_error");
    off += (size_t)n;
  }
  return buf;
}

static int valid_name(const char *s) {
  if (s[0] == '\0' || strlen(s) > 255) return 0;
  if (strchr(s, '/') != NULL) return 0;
  if (strcmp(s, ".") == 0 || strcmp(s, "..") == 0) return 0;
  return 1;
}

/* Walks all segments but the last from the root; returns the parent dirfd. */
static int walk(const char *root, char **segs, int nsegs) {
  int dirfd = open_root(root);
  hook("walk_root");
  for (int i = 0; i < nsegs - 1; i++) {
    int next = open_child_dir(dirfd, segs[i]);
    close(dirfd);
    dirfd = next;
    char hname[32];
    snprintf(hname, sizeof hname, "walk_%d", i);
    hook(hname);
  }
  return dirfd;
}

static size_t parse_len(const char *s, size_t max) {
  char *end = NULL;
  errno = 0;
  unsigned long long v = strtoull(s, &end, 10);
  if (errno != 0 || end == s || *end != '\0' || v > max) fail("io_error");
  return (size_t)v;
}

/*
 * Creates the staging directory under dirfd (mkdirat 0700, never an existing
 * one), opens it with O_NOFOLLOW, checks it is a directory owned by our UID
 * with mode 0700 and records its dev/ino. 0700 only keeps OTHER users out.
 */
static void open_staging_dir(int dirfd) {
  snprintf(g_stage_name, sizeof g_stage_name, ".calame-stage-%d-%08x", (int)getpid(),
           random_u32());
  if (mkdirat(dirfd, g_stage_name, 0700) != 0) {
    g_stage_name[0] = '\0';
    fail("io_error");
  }
  g_parent_fd = dirfd;
  int sfd = openat(dirfd, g_stage_name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  /* Without the fd we cannot identify the entry: leave it rather than guess. */
  if (sfd < 0) fail("io_error");
  struct stat st;
  if (fstat(sfd, &st) != 0) {
    close(sfd);
    fail("io_error");
  }
  g_stage_fd = sfd;
  g_stage_dev = st.st_dev;
  g_stage_ino = st.st_ino;
  if (!S_ISDIR(st.st_mode) || st.st_uid != getuid() || (st.st_mode & 0777) != 0700) {
    fail("io_error");
  }
}

/* Creates the temp file in the staging dir; keeps its fd open and records dev/ino. */
static void create_tmp(const char *tmpName, mode_t mode, const unsigned char *data, size_t len) {
  int fd = openat(g_stage_fd, tmpName, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, mode);
  if (fd < 0) fail("io_error");
  g_tmp_fd = fd;
  g_tmp_name = tmpName;
  struct stat st;
  if (fstat(fd, &st) != 0) fail("io_error");
  g_tmp_dev = st.st_dev;
  g_tmp_ino = st.st_ino;
  if (write_all_fd(fd, data, len) != len) fail("io_error");
  if (fsync(fd) != 0) fail("io_error");
}

/* Refuses to publish when <tmpName> in the staging dir is no longer our temp file. */
static void check_tmp_before_publish(const char *tmpName) {
  if (!entry_is(g_stage_fd, tmpName, g_tmp_dev, g_tmp_ino)) fail("io_error");
}

int main(int argc, char **argv) {
  if (argc < 5) fail("io_error");
  const char *cmd = argv[1];
  const char *root = argv[2];
  int i = 3;
  size_t maxBytes = 0, newLen = 0, oldLen = 0;
  const char *tmpName = NULL;

  if (strcmp(cmd, "read") == 0) {
    maxBytes = parse_len(argv[i++], ABSOLUTE_MAX);
  } else if (strcmp(cmd, "create") == 0) {
    newLen = parse_len(argv[i++], ABSOLUTE_MAX);
    tmpName = argv[i++];
  } else if (strcmp(cmd, "replace") == 0) {
    newLen = parse_len(argv[i++], ABSOLUTE_MAX);
    oldLen = parse_len(argv[i++], ABSOLUTE_MAX);
    tmpName = argv[i++];
  } else {
    fail("io_error");
  }
  if (i >= argc || strcmp(argv[i], "--") != 0) fail("io_error");
  i++;
  char **segs = argv + i;
  int nsegs = argc - i;
  if (nsegs < 1 || nsegs > 64) fail("io_error");
  for (int k = 0; k < nsegs; k++) {
    if (!valid_name(segs[k])) fail("invalid_path");
  }
  if (tmpName != NULL && !valid_name(tmpName)) fail("invalid_path");
  const char *name = segs[nsegs - 1];

  unsigned char *payload = NULL;
  if (tmpName != NULL) payload = read_stdin(newLen + oldLen);
  const unsigned char *newData = payload;
  const unsigned char *oldData = payload != NULL ? payload + newLen : NULL;

  int dirfd = walk(root, segs, nsegs);

  if (strcmp(cmd, "read") == 0) {
    hook("before_target");
    struct stat st;
    int fd = open_regular(dirfd, name, &st);
    if (fd < 0) {
      printf("OK -1\n");
      fflush(stdout);
      return 0;
    }
    size_t len = 0;
    unsigned char *buf = read_file(fd, &st, maxBytes, &len);
    printf("OK %zu\n", len);
    fflush(stdout);
    if (write_all_fd(1, buf, len) != len) return 1;
    return 0;
  }

  if (strcmp(cmd, "create") == 0) {
    struct stat st;
    int fd = open_regular(dirfd, name, &st);
    if (fd >= 0) fail("already_exists");
    hook("before_tmp");

    open_staging_dir(dirfd);
    create_tmp(tmpName, 0644, newData, newLen);
    hook("before_publish");

    check_tmp_before_publish(tmpName);
    hook("before_rename");
    /* Kernel-enforced create-only on the target name. */
    if (rename_create_only(g_stage_fd, tmpName, dirfd, name) != 0) {
      if (errno == EEXIST) fail("already_exists");
      if (unsupported_rename_errno(errno)) fail("unsupported_filesystem");
      fail("io_error");
    }

    /* From here on something HAS been published under `name`. If it is not
     * our temp file (same-UID substitution in the staging dir), say so: an
     * error here must not read as "nothing happened". No rollback. */
    if (!entry_is(dirfd, name, g_tmp_dev, g_tmp_ino)) fail("published_unverified");

    hook("before_cleanup");
    cleanup();
    printf("OK\n");
    fflush(stdout);
    return 0;
  }

  /* replace */
  struct stat first;
  int fd = open_regular(dirfd, name, &first);
  if (fd < 0) fail("not_found");
  size_t curLen = 0;
  unsigned char *cur = read_file(fd, &first, ABSOLUTE_MAX, &curLen);
  close(fd);
  if (curLen != oldLen || memcmp(cur, oldData, oldLen) != 0) fail("version_conflict");
  hook("before_tmp");

  open_staging_dir(dirfd);
  create_tmp(tmpName, first.st_mode & 0777, newData, newLen);
  hook("before_publish");

  /* Re-validate the target right before the swap (same inode, size, mtime and
     content). Not atomic with the swap: see the header. */
  struct stat again;
  int fd2 = open_regular(dirfd, name, &again);
  if (fd2 < 0) fail("version_conflict");
  if (again.st_ino != first.st_ino || again.st_dev != first.st_dev ||
      again.st_size != first.st_size || mtime_ns(&again) != mtime_ns(&first)) {
    close(fd2);
    fail("version_conflict");
  }
  size_t againLen = 0;
  unsigned char *cur2 = read_file(fd2, &again, ABSOLUTE_MAX, &againLen);
  close(fd2);
  if (againLen != oldLen || memcmp(cur2, oldData, oldLen) != 0) fail("version_conflict");

  check_tmp_before_publish(tmpName);
  hook("before_rename");
  /* Exchange: our temp goes to `name`, whatever was at `name` goes to
     <stage>/<tmpName>. */
  if (rename_exchange(g_stage_fd, tmpName, dirfd, name) != 0) {
    if (unsupported_rename_errno(errno)) fail("unsupported_filesystem");
    fail("io_error");
  }

  hook("after_exchange");
  /* Published. Both sides of the swap must be what we expect: our temp file
     at `name`, and the validated old file (same dev/ino) in the staging dir.
     A missing or different old entry is NOT success: we may have replaced
     something we never checked. The displaced entry is left in the staging
     dir (never deleted), and nothing is rolled back. */
  if (!entry_is(dirfd, name, g_tmp_dev, g_tmp_ino)) fail("published_unverified");
  /* Our temp file is at `name` but NOTHING came back into the staging dir:
     the exchange behaved like a plain rename-over. Observed on Docker
     Desktop (macOS) bind mounts (virtiofs, "fakeowner" in the container),
     where RENAME_EXCHANGE succeeds without moving the old file. Reported
     distinctly so the caller can confirm the published content by re-reading
     it; still not a plain success. */
  struct stat displaced;
  if (fstatat(g_stage_fd, tmpName, &displaced, AT_SYMLINK_NOFOLLOW) != 0 && errno == ENOENT) {
    fail("published_displaced_missing");
  }
  if (!entry_is(g_stage_fd, tmpName, first.st_dev, first.st_ino)) fail("published_unverified");

  hook("before_cleanup");
  /* Remove the verified old file through the held staging fd, single component. */
  if (entry_is(g_stage_fd, tmpName, first.st_dev, first.st_ino)) {
    unlinkat(g_stage_fd, tmpName, 0);
  }
  cleanup();
  printf("OK\n");
  fflush(stdout);
  return 0;
}
