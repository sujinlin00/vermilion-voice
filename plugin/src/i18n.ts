export type Lang = 'zh' | 'en';

const translations: Record<Lang, Record<string, string>> = {
  zh: {
    // Settings headings
    'settings.title': 'Vermilion Voice 设置',
    'settings.model': '模型选择',
    'settings.output': '输出设置',
    'settings.granularity': '识别粒度',
    'settings.audio': '音频设置',
    'settings.advanced': '高级',

    // Settings — Model
    'settings.inference': '推理精度',
    'settings.inference.desc': '标准：ONNX WASM CPU 本地推理，当前可用 | 高性能：ONNX WebGPU 推理（计划支持）',
    'settings.inference.standard': '标准 (ONNX WASM)',
    'settings.inference.performance': '高性能 (ONNX WebGPU)',
    'settings.modelDir': '模型目录',
    'settings.modelDir.desc': 'FunASR 模型的本地根目录，含 vad/, asr/, punc/ 子目录。留空则使用插件内置 models.json 下载到 lib/models/',
    'settings.modelDir.placeholder': '留空使用默认下载目录',

    // Settings — Output
    'settings.outputToNote': '输出至文档',
    'settings.outputToNote.desc': '开启后将转录文本写入笔记文件，关闭后仅在面板中显示',
    'settings.outputFolder': '转录文本路径',
    'settings.outputFolder.desc': '转录文本的输出路径（相对于保险库根目录）',
    'settings.saveAudio': '保存录音文件',
    'settings.saveAudio.desc': '录音结束后保存音频文件',
    'settings.recordingFolder': '录音文件路径',
    'settings.recordingFolder.desc': '录音文件的输出路径（相对于保险库根目录）',
    'settings.postProcess': '停止时进行二次识别',
    'settings.postProcess.desc': '录音结束后使用更高精度模型重新识别整段音频，输出完整文本',

    // Settings — Granularity
    'settings.vadSensitivity': '语音分段灵敏度',
    'settings.vadSensitivity.desc': 'VAD 切分灵敏度：高 = 短句快切，低 = 长句慢切（需重新开始识别生效）',
    'settings.vadSensitivity.high': '高（短句快切）',
    'settings.vadSensitivity.medium': '中（默认）',
    'settings.vadSensitivity.low': '低（长句慢切）',
    'settings.outputInterval': '文本推送间隔',
    'settings.outputInterval.desc': '转录文本输出到笔记的刷新频率',
    'settings.outputInterval.1s': '1 秒（实时）',
    'settings.outputInterval.3s': '3 秒（默认）',
    'settings.outputInterval.5s': '5 秒（省流）',
    'settings.silenceThreshold': '段落分隔静音',
    'settings.silenceThreshold.desc': '两个语音片段之间静音超过此值时输出换行',
    'settings.maxLineChars': '单行字数上限',
    'settings.maxLineChars.desc': '单行超过此字数后遇到标点自动换行',
    'settings.maxLineChars.unlimited': '不限制',
    'settings.maxSpeechDuration': '最长语音分段',
    'settings.maxSpeechDuration.desc': '单段语音超过此值自动切段（需重新开始识别生效）',
    'settings.maxSpeechDuration.short': '短段',
    'settings.maxSpeechDuration.default': '默认',
    'settings.maxSpeechDuration.long': '长段',
    'settings.maxSpeechDuration.extra': '超长段',

    // Settings — Audio
    'settings.audioMode': '音频采集模式',
    'settings.audioMode.desc': '选择音频来源（切换后立即生效）',
    'settings.audioMode.merge': '合并（推荐）',
    'settings.audioMode.mic': '仅麦克风',
    'settings.audioMode.output': '仅桌面音频',
    'settings.micDevice': '麦克风设备',
    'settings.micDevice.desc': '选择录音使用的麦克风。点击刷新获取设备列表（需授权麦克风权限）',
    'settings.micDevice.default': '默认麦克风',
    'settings.micDevice.refresh': '刷新设备列表',
    'settings.micDevice.device': '设备',

    // Settings — Advanced
    'settings.hotWords': '热词替换表',
    'settings.hotWords.desc': 'JSON 格式: {"误识别词": "正确词", ...}',

    // Settings — Language
    'settings.language': '语言',
    'settings.language.desc': '界面显示语言',

    // View
    'view.title': 'Vermilion Voice',
    'view.status.idle': '就绪',
    'view.btn.start': '开始识别',
    'view.btn.stop': '停止',
    'view.btn.clear': '清屏',
    'view.placeholder': '加载模型后点击"开始识别"开始实时语音识别',
    'view.buffer': '缓冲',
    'view.segments': '段数',

    // Status messages
    'status.ready': '模型就绪 — 开始识别',
    'status.requestMic': '请求麦克风...',
    'status.recording': '识别中...',
    'status.stopped': '已停止',
    'status.listening': '监听中...',
    'status.speaking': '说话中...',
    'status.asr': '识别中...',
    'status.punc': '标点中...',
    'status.startupFailed': '启动失败',

    // Notices
    'notice.audioModeSwitched': '音频采集模式已切换',
    'notice.audioModeFailed': '音频切换失败',
    'notice.audioModeNextStart': '下次开始识别时生效',
  },

  en: {
    // Settings headings
    'settings.title': 'Vermilion Voice Settings',
    'settings.model': 'Model',
    'settings.output': 'Output',
    'settings.granularity': 'Recognition',
    'settings.audio': 'Audio',
    'settings.advanced': 'Advanced',

    // Settings — Model
    'settings.inference': 'Inference Mode',
    'settings.inference.desc': 'Standard: ONNX WASM CPU local inference (available) | Performance: ONNX WebGPU inference (planned)',
    'settings.inference.standard': 'Standard (ONNX WASM)',
    'settings.inference.performance': 'Performance (ONNX WebGPU)',
    'settings.modelDir': 'Model Directory',
    'settings.modelDir.desc': 'Local root directory for FunASR models (vad/, asr/, punc/ subdirs). Leave empty to use built-in models.json download to lib/models/',
    'settings.modelDir.placeholder': 'Leave empty for default download directory',

    // Settings — Output
    'settings.outputToNote': 'Output to Note',
    'settings.outputToNote.desc': 'Write transcription to note file when enabled; show in panel only when disabled',
    'settings.outputFolder': 'Transcription Path',
    'settings.outputFolder.desc': 'Output path for transcribed text (relative to vault root)',
    'settings.saveAudio': 'Save Recording',
    'settings.saveAudio.desc': 'Save audio file after recording stops',
    'settings.recordingFolder': 'Recording Path',
    'settings.recordingFolder.desc': 'Output path for audio recordings (relative to vault root)',
    'settings.postProcess': 'Re-recognize on Stop',
    'settings.postProcess.desc': 'Re-recognize the entire audio with higher accuracy model after recording stops',

    // Settings — Granularity
    'settings.vadSensitivity': 'VAD Sensitivity',
    'settings.vadSensitivity.desc': 'VAD segmentation sensitivity: High = short segments, quick cuts; Low = long segments, slow cuts (restart recognition to apply)',
    'settings.vadSensitivity.high': 'High (quick cut)',
    'settings.vadSensitivity.medium': 'Medium (default)',
    'settings.vadSensitivity.low': 'Low (long segments)',
    'settings.outputInterval': 'Output Interval',
    'settings.outputInterval.desc': 'Refresh rate for transcription output to note',
    'settings.outputInterval.1s': '1s (realtime)',
    'settings.outputInterval.3s': '3s (default)',
    'settings.outputInterval.5s': '5s (low traffic)',
    'settings.silenceThreshold': 'Paragraph Silence',
    'settings.silenceThreshold.desc': 'Insert newline when silence between segments exceeds this value',
    'settings.maxLineChars': 'Max Line Length',
    'settings.maxLineChars.desc': 'Auto-wrap at punctuation when line exceeds this length',
    'settings.maxLineChars.unlimited': 'Unlimited',
    'settings.maxSpeechDuration': 'Max Speech Duration',
    'settings.maxSpeechDuration.desc': 'Force-cut speech segment when it exceeds this duration (restart recognition to apply)',
    'settings.maxSpeechDuration.short': 'Short',
    'settings.maxSpeechDuration.default': 'Default',
    'settings.maxSpeechDuration.long': 'Long',
    'settings.maxSpeechDuration.extra': 'Extra long',

    // Settings — Audio
    'settings.audioMode': 'Audio Capture Mode',
    'settings.audioMode.desc': 'Select audio source (takes effect immediately)',
    'settings.audioMode.merge': 'Merge (recommended)',
    'settings.audioMode.mic': 'Microphone only',
    'settings.audioMode.output': 'Desktop audio only',
    'settings.micDevice': 'Microphone Device',
    'settings.micDevice.desc': 'Select recording microphone. Click refresh to list devices (mic permission required)',
    'settings.micDevice.default': 'Default Microphone',
    'settings.micDevice.refresh': 'Refresh device list',
    'settings.micDevice.device': 'Device',

    // Settings — Advanced
    'settings.hotWords': 'Hot Word Replacement',
    'settings.hotWords.desc': 'JSON format: {"misrecognized": "correct", ...}',

    // Settings — Language
    'settings.language': 'Language',
    'settings.language.desc': 'Interface display language',

    // View
    'view.title': 'Vermilion Voice',
    'view.status.idle': 'Ready',
    'view.btn.start': 'Start',
    'view.btn.stop': 'Stop',
    'view.btn.clear': 'Clear',
    'view.placeholder': 'Load models then click "Start" to begin real-time speech recognition',
    'view.buffer': 'Buffer',
    'view.segments': 'Segments',

    // Status messages
    'status.ready': 'Models ready — start recognition',
    'status.requestMic': 'Requesting microphone...',
    'status.recording': 'Recording...',
    'status.stopped': 'Stopped',
    'status.listening': 'Listening...',
    'status.speaking': 'Speaking...',
    'status.asr': 'Recognizing...',
    'status.punc': 'Punctuating...',
    'status.startupFailed': 'Startup failed',

    // Notices
    'notice.audioModeSwitched': 'Audio capture mode switched',
    'notice.audioModeFailed': 'Audio switch failed',
    'notice.audioModeNextStart': 'Takes effect on next start',
  },
};

let currentLang: Lang = 'zh';

export function setLanguage(lang: Lang) {
  currentLang = lang;
}

export function getLanguage(): Lang {
  return currentLang;
}

export function t(key: string): string {
  return translations[currentLang][key] ?? translations['zh'][key] ?? key;
}
