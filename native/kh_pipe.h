/* Binary frame writer for the private pipe. Frames never touch stdout/stderr. */
#ifndef KH_PIPE_H
#define KH_PIPE_H

#include "kh_proto.h"

/* Writes one frame (header + payload) with EINTR/partial-write handling.
 * Returns 0 on success, -1 on failure (short of KH_ERR_PROTOCOL in caller). */
int kh_write_frame(int fd, unsigned char type, const void *payload, unsigned int len);

/* Convenience: payload is a little-endian u32 result code. */
int kh_write_code_frame(int fd, unsigned char type, int code);

/* Synthetic-test instrumentation only (chunked writes). No-op defaults;
 * the real helper never changes these from their zero values. */
void kh_pipe_set_chunk(unsigned int bytes, unsigned int delay_us);

#endif /* KH_PIPE_H */
