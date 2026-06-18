# PyInstaller spec for the Heario sidecar.
# Bundles ws_server.py + the entire heario-poc pipeline into a single .exe
# that Tauri can spawn with no Python installation required.

import os
from PyInstaller.utils.hooks import collect_all

poc = os.path.abspath(os.path.join(SPECPATH, '..', '..', 'heario-poc'))

# Collect native DLLs and all submodules for packages with C extensions
datas_ct2, bins_ct2, hidden_ct2 = collect_all('ctranslate2')
datas_fw,  bins_fw,  hidden_fw  = collect_all('faster_whisper')
datas_tok, bins_tok, hidden_tok = collect_all('tokenizers')
datas_ort, bins_ort, hidden_ort = collect_all('onnxruntime')

a = Analysis(
    [os.path.join(SPECPATH, 'ws_server.py')],
    pathex=[poc],
    binaries=[] + bins_ct2 + bins_fw + bins_tok + bins_ort,
    datas=[
        # Bundle the .env so keys travel with the exe (user can edit post-install)
        (os.path.join(poc, '.env'), '.'),
        # Bundle context.txt if it exists
        *( [(os.path.join(poc, 'context.txt'), '.')]
           if os.path.exists(os.path.join(poc, 'context.txt')) else [] ),
    ] + datas_ct2 + datas_fw + datas_tok + datas_ort,
    hiddenimports=[
        'assistant', 'config', 'capture', 'transcribe', 'stream_stt', 'local_whisper_stt', 'openai_whisper_stt',
        'search',
        'duckduckgo_search', 'duckduckgo_search.compat',
        'diarize', 'session_log', 'answer_history',
        'pyaudiowpatch', 'anthropic', 'deepgram', 'openai',
        'websockets', 'websockets.legacy', 'websockets.server',
        'asyncio', 'threading', 'queue',
        'requests', 'requests.adapters', 'requests.auth',
        'urllib3', 'certifi', 'charset_normalizer',
        'numpy', 'numpy.core', 'numpy.lib',
        'faster_whisper', 'ctranslate2', 'tokenizers', 'huggingface_hub',
        'onnxruntime',
    ] + hidden_ct2 + hidden_fw + hidden_tok + hidden_ort,
    hookspath=[],
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
)

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name='heario-sidecar',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    console=False,          # no terminal window visible to the user
    icon=os.path.join(SPECPATH, '..', 'src-tauri', 'icons', 'icon.ico'),
)
