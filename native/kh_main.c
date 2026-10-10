/* CLI entry for the K1 background Keychain helper candidate.
 *
 * Contract:
 *  - The secret travels ONLY over the private pipe fd (default 3), framed.
 *  - stdout/stderr carry usage or a numeric error code, never secret bytes.
 *  - The output fd must be a pipe/socket (never a regular file) and > 2, so a
 *    direct-terminal invocation or `3>file` redirection fails closed.
 *  - Any security call happens only after the fd is validated.
 *  - Real build: read-only lookup of the single allowlisted Chrome Safe
 *    Storage item; interaction suppressed in this same process, then restored.
 *  - Interactive prompting is available only with an explicit --interactive
 *    flag (setup path); the default path never prompts.
 */
/* POSIX.1-2008 declarations for the POSIX APIs used below; defined before the
 * first include so every header in this TU sees the same feature set. */
#define _POSIX_C_SOURCE 200809L

#include "kh_core.h"
#include "kh_ops.h"
#include "kh_pipe.h"
#include "kh_proto.h"

#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>

#ifdef KH_SYNTHETIC
#include "kh_fake_security.h"
#endif

typedef struct sink_ctx {
    int fd;
} sink_ctx;

static int pipe_sink(const unsigned char *bytes, unsigned int len, void *ctx) {
    sink_ctx *s = (sink_ctx *)ctx;
    return kh_write_frame(s->fd, KH_FRAME_SECRET, bytes, len) == 0 ? 0 : -1;
}

static void emit_error(int code) {
    /* Numeric classification only: no formatting of secret-derived data. */
    fprintf(stderr, "kh: error %d\n", code);
}

static void usage(FILE *out) {
    fputs("kh-helper — background Keychain read candidate (framed private pipe)\n"
          "Usage: kh-helper [--service NAME] [--account NAME] [--keychain PATH] "
          "[--fd N] [--interactive]\n"
          "Frames (magic KHF1) are written to private pipe fd N (default 3);\n"
          "stdout/stderr never receive secret bytes. Exit code = result code.\n"
          "--keychain confines the lookup to one keychain file by path (no\n"
          "search-list or default-keychain side effects); default is the search list.\n",
          out);
#ifdef KH_SYNTHETIC
    fputs("Synthetic build: [--fake-scenario NAME] (ok|denied|guard|restore|cleanup|\n"
          "hang|leak|chatty|noframes|badframe|chunked|endfail|deniedrestore|\n"
          "largecleanup) [--fake-delay-ms N] (sleep N ms before the read)\n",
          out);
#endif
}

static int parse_fd(const char *text, int *out) {
    char *end = NULL;
    long value;
    if (text == NULL || *text == '\0') return -1;
    value = strtol(text, &end, 10);
    if (end == NULL || *end != '\0' || value < 3 || value > 1024) return -1;
    *out = (int)value;
    return 0;
}

#ifdef KH_SYNTHETIC
/* Test-only pre-write delay so the executable EPIPE regression can close the
 * reader deterministically before the first frame write. Never in real build. */
static int parse_delay(const char *text, unsigned int *out) {
    char *end = NULL;
    long value;
    if (text == NULL || *text == '\0') return -1;
    value = strtol(text, &end, 10);
    if (end == NULL || *end != '\0' || value < 0 || value > 10000) return -1;
    *out = (unsigned int)value;
    return 0;
}
#endif

/* fd must be a pipe-like descriptor above the standard streams, else fail
 * closed: no secret may be written to a terminal, log file, or regular file. */
static int validate_pipe_fd(int fd) {
    struct stat st;
    if (fd < 3) return KH_ERR_ARGS;
    if (fcntl(fd, F_GETFD) == -1) return KH_ERR_NO_PIPE;
    if (fstat(fd, &st) != 0) return KH_ERR_NO_PIPE;
    if (!S_ISFIFO(st.st_mode) && !S_ISSOCK(st.st_mode)) return KH_ERR_NO_PIPE;
    return KH_OK;
}

#ifdef KH_SYNTHETIC
static void synthetic_pause(void) {
    struct timespec ts;
    ts.tv_sec = 30;
    ts.tv_nsec = 0;
    nanosleep(&ts, NULL);
}
#endif

int main(int argc, char **argv) {
    const char *service = KH_DEFAULT_SERVICE;
    const char *account = NULL; /* NULL = match any account for the service */
    const char *keychain_path = NULL; /* non-NULL = isolated fixture keychain by path */
    int fd = KH_DEFAULT_FD;
    int interactive = 0;
#ifdef KH_SYNTHETIC
    const char *scenario = "ok";
    unsigned int delay_ms = 0;
#endif
    sink_ctx ctx;
    kh_outcome outcome;
    int final_code;

    /* A closed reader must surface as a normal EPIPE write error so kh_run
     * still runs wipe/free/restore and classification; the default policy
     * would kill this process mid-cleanup via SIGPIPE (review finding 5). */
    signal(SIGPIPE, SIG_IGN);

    for (int i = 1; i < argc; i++) {
        const char *arg = argv[i];
        if (strcmp(arg, "--help") == 0) {
            usage(stdout);
            return 0;
        } else if (strcmp(arg, "--interactive") == 0) {
            interactive = 1;
        } else if (strcmp(arg, "--fd") == 0 && i + 1 < argc) {
            if (parse_fd(argv[++i], &fd) != 0) {
                emit_error(KH_ERR_ARGS);
                return KH_ERR_ARGS;
            }
        } else if (strcmp(arg, "--service") == 0 && i + 1 < argc) {
            service = argv[++i];
        } else if (strcmp(arg, "--account") == 0 && i + 1 < argc) {
            account = argv[++i];
        } else if (strcmp(arg, "--keychain") == 0 && i + 1 < argc) {
            keychain_path = argv[++i];
            /* An explicitly supplied empty path is invalid: it must never
             * degrade into a default-search-list lookup (review finding 1).
             * Rejected here, before any fd validation or Security call. */
            if (keychain_path[0] == '\0') {
                emit_error(KH_ERR_ARGS);
                return KH_ERR_ARGS;
            }
        }
#ifdef KH_SYNTHETIC
        else if (strcmp(arg, "--fake-scenario") == 0 && i + 1 < argc) {
            scenario = argv[++i];
        } else if (strcmp(arg, "--fake-delay-ms") == 0 && i + 1 < argc) {
            if (parse_delay(argv[++i], &delay_ms) != 0) {
                emit_error(KH_ERR_ARGS);
                return KH_ERR_ARGS;
            }
        }
#endif
        else {
            emit_error(KH_ERR_ARGS);
            return KH_ERR_ARGS;
        }
    }

#ifndef KH_SYNTHETIC
    /* The real helper is intentionally not a generic password exfiltration
     * tool: it serves exactly the one item the bridge needs. */
    if (strcmp(service, KH_DEFAULT_SERVICE) != 0) {
        emit_error(KH_ERR_ARGS);
        return KH_ERR_ARGS;
    }
#else
    kh_fake_set_scenario(scenario);
    kh_fake.expect_suppressed = interactive ? 0 : 1;
    if (service[0] == '\0') {
        emit_error(KH_ERR_ARGS);
        return KH_ERR_ARGS;
    }
#endif

    /* Validate the private pipe BEFORE any security call. */
    {
        const int fd_status = validate_pipe_fd(fd);
        if (fd_status != KH_OK) {
            emit_error(fd_status);
            return fd_status;
        }
    }

#ifdef KH_SYNTHETIC
    if (strcmp(scenario, "hang") == 0) {
        synthetic_pause();
        return 0;
    }
    if (strcmp(scenario, "leak") == 0) {
        /* Deliberate misbehavior used ONLY by bridge tests to prove the
         * bridge never echoes child output. Not present in the real build. */
        unsigned int len = 0;
        const char *secret = kh_fake_secret(&len);
        fwrite(secret, 1, len, stdout);
        fputc('\n', stdout);
        fflush(stdout);
        fprintf(stderr, "%s\n", secret);
        return 0;
    }
    if (strcmp(scenario, "noframes") == 0) return 3;
    if (strcmp(scenario, "badframe") == 0) {
        unsigned char garbage[KH_FRAME_HEADER_SIZE];
        memset(garbage, 'Z', sizeof(garbage));
        if (write(fd, garbage, sizeof(garbage)) < 0) return KH_ERR_PROTOCOL;
        return 0;
    }
    if (strcmp(scenario, "chunked") == 0) kh_pipe_set_chunk(3, 10000);
    if (delay_ms > 0) {
        struct timespec ts;
        ts.tv_sec = (time_t)(delay_ms / 1000u);
        ts.tv_nsec = (long)(delay_ms % 1000u) * 1000000L;
        while (nanosleep(&ts, &ts) != 0 && errno == EINTR) {
        }
    }
#endif

    ctx.fd = fd;
    {
        const unsigned int account_len = account ? (unsigned int)strlen(account) : 0;
        kh_run(&kh_security, keychain_path, service, (unsigned int)strlen(service), account,
               account_len, interactive ? 0 : 1, pipe_sink, &ctx, &outcome);
    }
    final_code = outcome.final;

    /* Frame 1 contract: ERROR(code) when the read failed, otherwise the sink
     * already emitted the SECRET frame during kh_run. */
    if (outcome.acquisition != KH_OK)
        (void)kh_write_code_frame(fd, KH_FRAME_ERROR, outcome.acquisition);

#ifdef KH_SYNTHETIC
    if (strcmp(scenario, "endfail") == 0) final_code = KH_ERR_RESTORE_FAILED;
#endif

    if (kh_write_code_frame(fd, KH_FRAME_END, final_code) != 0 && final_code == KH_OK)
        final_code = KH_ERR_PROTOCOL;

#ifdef KH_SYNTHETIC
    if (strcmp(scenario, "chatty") == 0 && final_code == KH_OK) {
        /* Deliberate misbehavior used ONLY by bridge tests: valid frames plus
         * a secret on stdout. The bridge must reject this as a leak. */
        unsigned int len = 0;
        const char *secret = kh_fake_secret(&len);
        fwrite(secret, 1, len, stdout);
        fputc('\n', stdout);
        fflush(stdout);
    }
#endif

    if (final_code != KH_OK) emit_error(final_code);
    return final_code;
}
