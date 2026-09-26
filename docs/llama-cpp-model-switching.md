# 使用 llama.cpp Router 切換本機模型

本文記錄在 Windows 上以 llama.cpp `b10621` 啟動 router，並在 cloudcode 中切換本機 GGUF 模型的方法。

## 環境

- llama.cpp：`F:\llama_cpp\llama-b10621-bin-win-cuda-13.3-x64\llama-server.exe`
- 模型目錄：`F:\llama_cpp_models`
- cloudcode provider 設定：`%USERPROFILE%\.cloudcode\providers.json`
- 本機服務位址：`http://127.0.0.1:8080`

目前模型目錄內的主模型是 `Ornith-1.5-35B-Q4_K_M.gguf`，並有 `mmproj-Ornith-1.5-35B-BF16.gguf` 及 `chat_template.jinja`。

## 啟動 llama.cpp Router

在 PowerShell 執行：

```powershell
& 'F:\llama_cpp\llama-b10621-bin-win-cuda-13.3-x64\llama-server.exe' `
  --models-dir 'F:\llama_cpp_models' `
  --host 127.0.0.1 `
  --port 8080 `
  --models-max 1 `
  --jinja `
  --chat-template-file 'F:\llama_cpp_models\chat_template.jinja' `
  --reasoning-format deepseek
```

Router 模式不指定 `-m`；`--models-dir` 指向模型目錄。`--models-max 1` 限制同時載入的模型數量，適合需要在模型間切換、但不想同時占用多份顯存的情況。Router 會在收到對應模型的請求時載入模型。

目前目錄中的 `chat_template.jinja` 是為現有模型準備的工具呼叫模板。新增其他模型家族時，請確認此模板適用於該模型；工具呼叫需要模型模板支援工具格式。

## 設定 cloudcode Provider

在 `%USERPROFILE%\.cloudcode\providers.json` 新增或合併 `local` 欄位：

```json
{
  "local": {
    "baseUrl": "http://127.0.0.1:8080",
    "apiKey": "none",
    "model": "Ornith-1.5-35B-Q4_K_M.gguf",
    "model_context_window": 32768
  }
}
```

如果檔案已有其他 provider，保留原有欄位並合併 `local`，不要用上面的範例覆蓋整份設定。這裡不設定 `"kind": "openai"`，因為 cloudcode 的 llama.cpp 整合使用 Anthropic 相容的 `/v1/messages` API。

`model_context_window` 應設為模型實際可用的 context 長度；它影響 cloudcode 顯示的 context 使用率及自動 compact 時機。`32768` 是範例值，請依模型實際設定調整。

## 啟動 cloudcode 並切換模型

啟動時選擇 `local` provider：

```powershell
npm run dev -- --provider local
```

也可以在 cloudcode 執行期間輸入：

```text
/provider local
/model
```

`/model` 會顯示服務端可用的模型 ID。使用列表中的 ID 切換：

```text
/model <模型ID>
```

切換後的後續請求會交由 router 路由至指定模型；未載入的模型會自動載入。查詢 router 回報的 ID 也可在另一個 PowerShell 視窗執行：

```powershell
Invoke-RestMethod 'http://127.0.0.1:8080/models'
```

目前模型目錄只有一個主模型，因此要有多個切換選項，需將其他 GGUF 模型加入目錄。單檔模型可放在目錄中；多分片或多模態模型依 llama.cpp 文件建議放入各自的子目錄。

## 參考

- [llama.cpp Server 文件：多模型 Router 與模型目錄](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md#using-multiple-models)
- [cloudcode README：Local models (llama.cpp)](../README.md#local-models-llamacpp)
