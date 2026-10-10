# K1 background Keychain helper candidate — build + test driver.
# Synthetic targets are what `make test` runs; they never touch the OS Keychain.
# `make compile-real` only COMPILES the macOS helper against Security.framework;
# the test suite never executes it.

CC ?= clang
CFLAGS ?= -std=c11 -Wall -Wextra -Werror -O2
DEPLOYMENT_TARGET ?= 11.0
INCLUDES = -I native -I test
BUILD = build

NATIVE_HEADERS = native/kh_proto.h native/kh_ops.h native/kh_core.h native/kh_pipe.h
SYN_SOURCES = native/kh_core.c native/kh_pipe.c native/kh_main.c test/kh_fake_security.c
CORE_TEST_SOURCES = native/kh_core.c test/kh_fake_security.c test/kh_core.test.c
PIPE_TEST_SOURCES = native/kh_pipe.c test/kh_pipe.test.c
REAL_SOURCES = native/kh_core.c native/kh_pipe.c native/kh_main.c native/kh_security_real.c

.PHONY: all unit bridge test compile-real clean

all: $(BUILD)/kh-helper-synthetic $(BUILD)/kh-core-test $(BUILD)/kh-pipe-test

$(BUILD):
	mkdir -p $(BUILD)

$(BUILD)/kh-helper-synthetic: $(SYN_SOURCES) $(NATIVE_HEADERS) test/kh_fake_security.h | $(BUILD)
	$(CC) $(CFLAGS) -DKH_SYNTHETIC $(INCLUDES) -o $@ $(SYN_SOURCES)

$(BUILD)/kh-core-test: $(CORE_TEST_SOURCES) $(NATIVE_HEADERS) test/kh_fake_security.h | $(BUILD)
	$(CC) $(CFLAGS) $(INCLUDES) -o $@ $(CORE_TEST_SOURCES)

$(BUILD)/kh-pipe-test: $(PIPE_TEST_SOURCES) native/kh_pipe.h native/kh_proto.h | $(BUILD)
	$(CC) $(CFLAGS) $(INCLUDES) -o $@ $(PIPE_TEST_SOURCES)

# Real macOS helper: compile-only here. Executing it would touch the real
# keychain search list read path; that is the remaining manual K1 step.
$(BUILD)/kh-helper: $(REAL_SOURCES) $(NATIVE_HEADERS) | $(BUILD)
	$(CC) $(CFLAGS) -mmacosx-version-min=$(DEPLOYMENT_TARGET) $(INCLUDES) -framework Security -framework CoreFoundation -o $@ $(REAL_SOURCES)

compile-real: $(BUILD)/kh-helper

unit: all
	$(BUILD)/kh-core-test
	$(BUILD)/kh-pipe-test

bridge: all
	node --test test/

test: unit bridge

clean:
	rm -rf $(BUILD)
