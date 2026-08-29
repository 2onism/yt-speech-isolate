# Model: DeepFilterNet3

Speech enhancement at 48 kHz. Music reduction is good enough, not stem separation.

Package: deepfilternet3-noise-filter (Apache-2.0 OR MIT)
Upstream: Rikorose DeepFilterNet
Wrapper: mezonai mezon-noise-suppression
Citation: Schroter et al., ICASSP 2022, arXiv 2110.05588.

Build copies WASM and ONNX into dist/assets and dist/models.
Hashes go in dist/assets/HASHES.txt. Sizes filled after first build.

Measured after build:
- dist/assets/df_bg.wasm: 16418651 bytes (15.66 MiB)
- dist/models/DeepFilterNet3_onnx.tar.gz: 7983136 bytes (7.61 MiB)
See dist/assets/HASHES.txt for SHA-256.
