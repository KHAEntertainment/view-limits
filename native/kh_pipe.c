#include "kh_pipe.h"

#include <errno.h>
#include <string.h>
#include <unistd.h>

#if defined(__APPLE__)
#include <time.h>
#endif

static unsigned int chunk_bytes = 0;
static unsigned int chunk_delay_us = 0;

void kh_pipe_set_chunk(unsigned int bytes, unsigned int delay_us) {
    chunk_bytes = bytes;
    chunk_delay_us = delay_us;
}

static void chunk_pause(void) {
    if (chunk_delay_us == 0) return;
    struct timespec ts;
    ts.tv_sec = (time_t)(chunk_delay_us / 1000000u);
    ts.tv_nsec = (long)(chunk_delay_us % 1000000u) * 1000L;
    while (nanosleep(&ts, &ts) != 0 && errno == EINTR) {
    }
}

/* Writes the full span; returns 0 on success, -1 on error/EOF. */
static int write_all(int fd, const unsigned char *data, unsigned int len) {
    unsigned int done = 0;
    const unsigned int step = chunk_bytes > 0 ? chunk_bytes : len;
    while (done < len) {
        unsigned int span = len - done;
        if (chunk_bytes > 0 && span > step) span = step;
        ssize_t wrote = write(fd, data + done, (size_t)span);
        if (wrote < 0) {
            if (errno == EINTR) continue;
            return -1;
        }
        if (wrote == 0) return -1;
        done += (unsigned int)wrote;
        if (chunk_bytes > 0 && done < len) chunk_pause();
    }
    return 0;
}

int kh_write_frame(int fd, unsigned char type, const void *payload, unsigned int len) {
    unsigned char header[KH_FRAME_HEADER_SIZE];
    if (len > KH_MAX_PAYLOAD) return -1;
    header[0] = KH_FRAME_MAGIC0;
    header[1] = KH_FRAME_MAGIC1;
    header[2] = KH_FRAME_MAGIC2;
    header[3] = KH_FRAME_MAGIC3;
    header[4] = type;
    header[5] = 0; /* flags */
    header[6] = 0;
    header[7] = 0; /* reserved, LE */
    header[8] = (unsigned char)(len & 0xffu);
    header[9] = (unsigned char)((len >> 8) & 0xffu);
    header[10] = (unsigned char)((len >> 16) & 0xffu);
    header[11] = (unsigned char)((len >> 24) & 0xffu);
    if (write_all(fd, header, KH_FRAME_HEADER_SIZE) != 0) return -1;
    if (len > 0 && write_all(fd, (const unsigned char *)payload, len) != 0) return -1;
    return 0;
}

int kh_write_code_frame(int fd, unsigned char type, int code) {
    unsigned char payload[4];
    const unsigned int v = (unsigned int)code;
    payload[0] = (unsigned char)(v & 0xffu);
    payload[1] = (unsigned char)((v >> 8) & 0xffu);
    payload[2] = (unsigned char)((v >> 16) & 0xffu);
    payload[3] = (unsigned char)((v >> 24) & 0xffu);
    return kh_write_frame(fd, type, payload, 4);
}
