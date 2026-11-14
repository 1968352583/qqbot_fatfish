# 当前服务器与 Breeze TTS 2 的适配性

2026-11-14 检查结论：现有服务器无法按该项目当前实现正常承载 Breeze TTS 2，不能将它与机器人一起部署后宣称语音可用。

服务器实测为 Alibaba Cloud Linux 3、x86_64、2 个逻辑 CPU、1870 MiB 内存和 1 GiB swap，未发现 NVIDIA GPU。用户本地模型的两个主权重文件与音频 tokenizer 权重共约 7.124 GiB，已高于服务器内存及 swap 总量；加载时还有框架、缓存及中间结果开销。

本地 `breeze_infer/runtime.py` 存在 CPU 回退路径，但会按 bfloat16 加载完整模型并移动到目标设备，同时加载音频 tokenizer，没有可直接使用的低内存分层卸载方案。`infer_mac.py` 默认使用 MPS，只适用于相应的 Mac 环境，不会让普通 x86 云服务器获得 Apple GPU 能力。

[官方模型说明](https://huggingface.co/BreezeBlue/Breeze-TTS-2#requirements)要求 Linux、Python 3.10+ 和 CUDA NVIDIA GPU；普通推理约需 7.7 GiB 显存，建议至少 12 GB 显存，快速路径建议 24 GB。服务器 Python 3.6 也需要升级，但升级 Python 无法补足内存和 GPU。

这是依据实际资源、权重大小、代码加载方式和官方要求做出的适配判断；没有在生产服务器上尝试加载数 GiB 模型或进行推理压测。机器人本体使用远端 DeepSeek，系统资源需求远小于本地 TTS 模型，可以独立部署。当前语音输出回退为文字，后续可使用独立语音 API 或具备足够资源的 Breeze 推理主机。

接入 Breeze 时还需适配协议：[官方代码](https://github.com/breezeblue-ai/breeze-tts)提供 multipart 请求和 24 kHz 单声道 s16le PCM 流，而本项目现有 HTTP 语音适配器使用 JSON 请求与 WAV 响应，不能仅填写地址就直接兼容。
