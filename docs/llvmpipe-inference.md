# Inference on a GPU-less host: upstream serve on llvmpipe

Upstream Koharu 0.97.0's `serve` runs detect/OCR on a GPU-less host only with
`GGML_VK_VISIBLE_DEVICES=0` in its environment. Without it every model run fails:

```
ggml_vulkan: No devices found.
Error: Vulkan can't be used: llama.cpp doesn't list Vulkan0 at 0
```

## Why it fails without the variable

The chain, each link verified in upstream source:

1. `crates/koharu-runtime/src/hardware/vulkan.rs:5-16` — the Vulkan probe
   returns a placeholder `Vulkan0` device whenever `libvulkan.so.1` loads. On
   Linux the probe list is CUDA, HIP, Vulkan only; there is no CPU candidate.
2. `crates/koharu-runtime/src/lib.rs:48-60` — `device()` takes the first
   candidate and has no fallback. A failed GPU is a hard failure.
3. `crates/koharu-runtime/src/packages/ggml.rs:75-87` — `listed()` requires ggml
   to enumerate a device named `Vulkan0` at index 0.
4. llama.cpp b12565 `ggml/src/ggml-vulkan/ggml-vulkan.cpp:5993` — ggml-vulkan
   accepts only `eDiscreteGpu` and `eIntegratedGpu` device types. lavapipe
   reports `eCpu`, so it is filtered out and ggml lists only the CPU device.

The renderer's wgpu finds the lavapipe adapter fine, so rendering works while
inference fails. The loader is not the problem; the deviceType filter is.

## The fix

`ggml-vulkan.cpp:5961-5976`: when `GGML_VK_VISIBLE_DEVICES` is set, the indices
are pushed without the deviceType and support checks. `GGML_VK_VISIBLE_DEVICES=0`
makes llvmpipe enumerate as `Vulkan0`, `listed()` passes, and serve logs:

```
models run on llvmpipe (LLVM 23.1.3, 256 bits)
```

Verified two ways:

- Direct probe of the pinned llama package
  (`x86_64-unknown-linux-gnu-vulkan`; load order `libllama.so`, `libmtmd.so`,
  `libllama-common.so`, RTLD_GLOBAL): without the variable
  `ggml_backend_dev_count` is 1 (`CPU`); with it, 2
  (`[0] Vulkan0 :: llvmpipe`, `[1] CPU`).
- A live `run` on a real project: both packages and the device load, and the
  detect stage proceeds.

## How to start serve on a GPU-less host

```bash
GGML_VK_VISIBLE_DEVICES=0 \
  serve --port 7878 \
  manga/<gallery>/project.khr manga/<gallery>/source/*.jpg
```

The index must be below the physical device count the loader enumerates. When
lavapipe is the only device, that index is 0.

## Caveats

- llama.cpp prints `Warning: Device type is CPU. This is probably not the
  device you want.` — expected on a GPU-less host, not an error.
- ggml-vulkan on llvmpipe is slower than the ggml-cpu path; the detector is
  unaffected (torch ships no Vulkan build, so `packages/torch.rs:110-116` maps
  a Vulkan device to CPU torch).
- No CPU package variant is needed: the vulkan llama package already contains
  the CPU backend, and Koharu's torch download for a Vulkan device is the CPU
  torch.
- Environment-only. No source patch.
