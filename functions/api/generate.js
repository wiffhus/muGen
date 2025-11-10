/**
 * Cloudflare Function (v13)
 * Handles API requests for:
 * - auth
 * - translate
 * - generate_fg (Foreground Generation)
 * - generate_bg (Background Queueing)
 * - check_status (Polling)
 * - logError
 * * Bindings Required:
 * - MUGEN_KV (KV Namespace)
 * - MUGEN_QUEUE (Queue)
 * - GEMINI_API_KEY_XX (Env)
 * - GEMINI_FLASH_IMAGE_API_KEY_XX (Env)
 * - MUGEN_PASSWORD (Env)
 * - GAS_WEB_APP_URL (Env)
 */

// API URLs (v12と同じ)
const GEMINI_API_URL_FLASH_IMAGE_2_5 = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image-preview:generateContent";
const GEMINI_API_URL_FLASH_IMAGE_2_0 = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-preview-image-generation:generateContent";
const GEMINI_API_URL_FLASH = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-09-2025:generateContent";

// KVの有効期限 (30分)
const KV_EXPIRATION_TTL = 1800; 

/**
 * メインリクエストハンドラ
 */
export async function onRequest(context) {
    if (context.request.method !== 'POST') {
        return jsonResponse({ error: 'Method Not Allowed' }, 405);
    }

    let data;
    try {
        data = await context.request.json();
    } catch (e) {
        return jsonResponse({ error: 'Invalid JSON body' }, 400);
    }
    
    const { action } = data;

    try {
        switch (action) {
            case 'auth':
                return await handleAuth(data, context);
            case 'logError':
                return await handleErrorLog(data, context); // (v12と同じ)

            // --- ここから先の操作は認証が必要 ---
            // (簡易的に認証チェックは省略。v12と同様)

            case 'translate':
                return await handleTranslate(data, context); // (v12と同じ)
            
            case 'generate_fg':
                // フォアグラウンド (今すぐ実行)
                return await handleGenerateForeground(data, context);
            
            case 'generate_bg':
                // バックグラウンド (キュー登録)
                return await handleGenerateBackground(data, context);

            case 'check_status':
                // バックグラウンド (ポーリング)
                return await handleCheckStatus(data, context);
                
            case 'edit':
                // 'edit' は 'generate_fg' に統合 (v12からの互換性のため残してもよいが、v13では 'generate_fg' を使う)
                return await handleGenerateForeground(data, context);

            default:
                return jsonResponse({ error: 'Invalid action' }, 400);
        }
    } catch (error) {
        console.error("Server Error (onRequest):", error);
        // 予期せぬエラーもGASに記録
        await handleErrorLog({
            prompt: data.prompt || "N/A",
            model: data.model || "N/A",
            error: `Server Error: ${error.message}`
        }, context).catch(logError => console.error("Failed to log server error to GAS:", logError));
        
        return jsonResponse({ error: error.message || 'An unexpected error occurred' }, 500);
    }
}

// --- ヘルパー ---

/**
 * JSONレスポンスを返す
 */
function jsonResponse(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status: status,
        headers: { 'Content-Type': 'application/json' },
    });
}

/**
 * APIキーを取得する (v12と同じ)
 */
function getApiKey(context, model, keyIndex) {
    const keyPoolSize = 10; 
    const index = (keyIndex || 0) % keyPoolSize + 1;
    const keyIndexStr = index.toString().padStart(2, '0');
    let apiKeyEnvVar;
    
    if (model === 'gemini-2.5-flash-image-preview' || model === 'gemini-2.0-flash-preview-image-generation') {
        apiKeyEnvVar = `GEMINI_FLASH_IMAGE_API_KEY_${keyIndexStr}`;
    } else {
        apiKeyEnvVar = `GEMINI_API_KEY_${keyIndexStr}`;
    }
    const apiKey = context.env[apiKeyEnvVar];
    if (!apiKey) {
        throw new Error(`Server configuration error: Missing API Key (${apiKeyEnvVar})`);
    }
    return apiKey;
}

// --- アクションハンドラ (v12から変更なし) ---

async function handleAuth(data, context) {
    const { password } = data;
    const masterPassword = context.env.MUGEN_PASSWORD;
    if (!masterPassword) {
        console.error("MUGEN_PASSWORD environment variable is not set.");
        return jsonResponse({ error: 'Server configuration error: Auth not set up.' }, 500);
    }
    if (!password) {
        return jsonResponse({ error: 'Password is required' }, 400);
    }
    let mismatch = 0;
    if (password.length !== masterPassword.length) {
        mismatch = 1;
    } else {
        for (let i = 0; i < password.length; i++) {
            mismatch |= (password.charCodeAt(i) ^ masterPassword.charCodeAt(i));
        }
    }
    if (mismatch !== 0) {
        return jsonResponse({ error: 'Invalid password' }, 401);
    }
    return jsonResponse({ success: true });
}

async function handleTranslate(data, context) {
    const { prompt, keyIndex } = data;
    if (!prompt) {
        return jsonResponse({ error: 'Prompt is required' }, 400);
    }
    const apiKey = getApiKey(context, 'default', keyIndex);
    const systemPrompt = "You are a translation assistant. Translate the following text into a clear, effective, and creative English prompt for an AI image generator. If the input is already in English, refine it for clarity and creative potential.";
    const userQuery = `Translate and refine: "${prompt}"`;
    const apiUrl = `${GEMINI_API_URL_FLASH}?key=${apiKey}`;
    const payload = {
        contents: [{ parts: [{ text: userQuery }] }],
        systemInstruction: { parts: [{ text: systemPrompt }] },
    };
    const response = await fetch(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });
    if (!response.ok) {
        const errorText = await response.text();
        console.error("Translate API Error:", errorText);
        return jsonResponse({ error: 'Failed to translate' }, 500);
    }
    const result = await response.json();
    const translatedPrompt = result.candidates[0].content.parts[0].text;
    return jsonResponse({ translatedPrompt });
}

async function handleErrorLog(data, context) {
    const { prompt, model, error } = data;
    const gasUrl = context.env.GAS_WEB_APP_URL;
    if (!gasUrl) {
        console.warn("GAS_WEB_APP_URL is not set. Error logging failed.");
        return jsonResponse({ error: 'GAS URL not configured' }, 500);
    }
    const saveData = {
        prompt: prompt,
        translatedPrompt: `[ERROR] ${error}`,
        base64Data: "ERROR",
        model: model,
        isError: true 
    };
    try {
        // We don't await this, let it run in the background
        context.waitUntil(
            fetch(gasUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(saveData)
            }).catch(err => console.error("GAS error logging failed:", err))
        );
        return jsonResponse({ success: true });
    } catch (err) {
        // This catch is unlikely to be hit due to waitUntil, but good practice.
        console.error("GAS error logging submission error:", err);
        return jsonResponse({ error: 'Failed to log error to GAS' }, 500);
    }
}


// --- v13: 新しいハンドラ ---

/**
 * (FG) フォアグラウンドで画像を即時生成する
 * (v12の handleGenerate / handleEdit を統合)
 */
async function handleGenerateForeground(data, context) {
    const { prompt, model, keyIndex, aspectRatio, styles, baseImage } = data;
    const apiKey = getApiKey(context, model, keyIndex);

    try {
        let result;
        if (model.startsWith('imagen-')) {
            result = await callImagenApi(prompt, aspectRatio, styles, model, apiKey);
        } else if (model === 'gemini-2.5-flash-image-preview' || model === 'gemini-2.0-flash-preview-image-generation') {
            result = await callGeminiApi(prompt, baseImage, model, apiKey);
        } else {
            return jsonResponse({ error: 'Invalid model for generation' }, 400);
        }

        // FGではGAS保存は行わない (Consumer側で行うため、v12から削除)
        // ※ FGでもGAS保存したい場合は、v12のGAS保存ロジックをここに移植する

        return jsonResponse(result);

    } catch (error) {
        console.error(`FG ${model} API Error:`, error.message);
        // エラーをGASに送信
        await handleErrorLog({ prompt: prompt, model: model, error: error.message }, context);
        return jsonResponse({ error: error.message }, 500);
    }
}

/**
 * (BG) バックグラウンドジョブをQueueに登録する
 */
async function handleGenerateBackground(data, context) {
    const { MUGEN_QUEUE, MUGEN_KV } = context.env;
    if (!MUGEN_QUEUE || !MUGEN_KV) {
        return jsonResponse({ error: 'Server configuration error: Queue/KV not bound.' }, 500);
    }

    // ジョブIDを生成
    const jobId = crypto.randomUUID();
    
    // data (payload) に jobId を追加
    const jobPayload = { ...data, jobId: jobId };

    try {
        // 1. ジョブをQueueに送信
        await MUGEN_QUEUE.send(jobPayload);
        
        // 2. KVに「保留中」ステータスを書き込む (有効期限付き)
        await MUGEN_KV.put(jobId, JSON.stringify({ status: 'pending' }), {
            expirationTtl: KV_EXPIRATION_TTL 
        });

        // 3. フロントに jobId を返す
        return jsonResponse({ jobId: jobId });

    } catch (error) {
        console.error("Queue send error:", error);
        return jsonResponse({ error: `Failed to queue job: ${error.message}` }, 500);
    }
}

/**
 * (BG) ポーリングリクエストを処理し、KVのステータスを確認する
 */
async function handleCheckStatus(data, context) {
    const { MUGEN_KV } = context.env;
    const { jobId } = data;

    if (!MUGEN_KV) {
        return jsonResponse({ error: 'Server configuration error: KV not bound.' }, 500);
    }
    if (!jobId) {
        return jsonResponse({ error: 'Job ID is required' }, 400);
    }

    try {
        const kvValue = await MUGEN_KV.get(jobId);
        if (!kvValue) {
            // データがない (期限切れ or 存在しない)
            return jsonResponse({ status: 'error', error: 'Job not found or expired.' });
        }

        const result = JSON.parse(kvValue);

        if (result.status === 'complete' || result.status === 'error') {
            // 完了またはエラーの場合、KVからデータを削除
            await MUGEN_KV.delete(jobId);
        }

        return jsonResponse(result); // { status: 'pending' } or { status: 'complete', ... } or { status: 'error', ... }

    } catch (error) {
        console.error("KV check error:", error);
        return jsonResponse({ error: `Failed to check status: ${error.message}` }, 500);
    }
}


// --- API呼び出し (v12から移植・エラー処理変更) ---

async function callImagenApi(prompt, aspectRatio, styles, model, apiKey) {
    let enhancedPrompt = prompt;
    if (styles && styles.length > 0) {
        enhancedPrompt += `, ${styles.join(', ')} style`;
    }

    let apiModelName = model;
    if (model === 'imagen-3.0-generate') {
        apiModelName = 'imagen-3.0-generate-002';
    }
    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${apiModelName}:predict?key=${apiKey}`;
    
    const payload = {
        instances: { prompt: enhancedPrompt },
        parameters: {
            "aspectRatio": aspectRatio,
            "sampleCount": 1,
            "safetySettings": { "violence": "BLOCK_NONE", "sexual": "BLOCK_NONE", "hate": "BLOCK_NONE", "dangerous": "BLOCK_NONE" }
        }
    };

    const response = await fetch(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });

    if (!response.ok) {
        const errorText = await response.text();
        // ★ v13: エラーをスローする
        throw new Error(`Imagen API Error: ${errorText}`);
    }

    const result = await response.json();
    const base64 = result.predictions[0].bytesBase64Encoded;
    
    return { base64: base64, translatedPrompt: enhancedPrompt };
}

async function callGeminiApi(prompt, baseImage, model, apiKey) {
    let apiUrl = (model === 'gemini-2.0-flash-preview-image-generation') 
        ? `${GEMINI_API_URL_FLASH_IMAGE_2_0}?key=${apiKey}`
        : `${GEMINI_API_URL_FLASH_IMAGE_2_5}?key=${apiKey}`;
    
    const isEditMode = !!baseImage;
    const userParts = [{ text: prompt }];
    if (isEditMode) {
        userParts.push({ inlineData: { mimeType: "image/png", data: baseImage } });
    }

    const payload = {
        contents: [{ role: "user", parts: userParts }],
        generationConfig: { responseModalities: ['TEXT', 'IMAGE'] },
        safetySettings: [
            { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" }
        ]
    };

    const response = await fetch(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });

    if (!response.ok) {
        const errorText = await response.text();
        // ★ v13: エラーをスローする
        throw new Error(`Gemini API Error: ${errorText}`);
    }

    const result = await response.json();
    const base64 = result?.candidates?.[0]?.content?.parts?.find(p => p.inlineData)?.inlineData?.data;

    if (!base64) {
        const errorText = result?.candidates?.[0]?.content?.parts?.[0]?.text;
        let errorMessage;
        if (result?.candidates?.[0]?.finishReason === 'SAFETY') {
             errorMessage = `Image blocked due to safety settings.`;
        } else {
             errorMessage = `Gemini Error: ${errorText || 'No image data returned'}`;
        }
        // ★ v13: エラーをスローする
        throw new Error(errorMessage);
    }
    
    // Geminiは翻訳を行わないので、元のプロンプトをそのまま返す
    return { base64: base64, translatedPrompt: prompt };
}
