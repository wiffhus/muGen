/**
 * Cloudflare Function (Node.js) - v13 (ウェイター)
 *
 * FG (フォアグラウンド) モード:
 * - action 'generate_fg', 'edit_fg'
 * - 従来通り、直接AIを呼び出す。
 *
 * BG (バックグラウンド) モード:
 * - action 'submit_bg_job':
 * - ジョブをKV (伝票置き場) に 'job:[jobId]' として保存する。
 * - action 'check_bg_job':
 * - KV (受け渡し口) から 'result:[jobId]' を確認し、あれば返す。
 *
 * 共通:
 * - action 'translate', 'auth', 'logError'
 */

// --- APIエンドポイント ---
const GEMINI_API_URL_FLASH_IMAGE_2_5 = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image-preview:generateContent";
const GEMINI_API_URL_FLASH_IMAGE_2_0 = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-preview-image-generation:generateContent";
const GEMINI_API_URL_FLASH = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-09-2025:generateContent";


/**
 * APIキーを取得する
 */
function getApiKey(context, model, keyIndex) {
    const keyPoolSize = 10; // 01から10までのキー
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
        console.error(`Missing API Key: ${apiKeyEnvVar}`);
        throw new Error(`Server configuration error: Missing API Key (${apiKeyEnvVar})`);
    }
    return apiKey;
}

/**
 * メインリクエストハンドラ (ルーター)
 */
export async function onRequest(context) {
    if (context.request.method !== 'POST') {
        return new Response(JSON.stringify({ error: 'Method Not Allowed' }), { status: 405 });
    }

    let data;
    try {
        data = await context.request.json();
    } catch (e) {
        return new Response(JSON.stringify({ error: 'Invalid JSON body' }), { status: 400 });
    }

    const { action, model, keyIndex } = data;

    try {
        let response;
        switch (action) {
            // --- 共通アクション ---
            case 'logError':
                response = await handleErrorLog(data, context);
                break;
            case 'auth':
                response = await handleAuth(data, context);
                break;
            case 'translate':
                // 翻訳はFGのみ (キーインデックスをdataから取得)
                const translateApiKey = getApiKey(context, 'default', data.keyIndex);
                response = await handleTranslate(data, translateApiKey);
                break;

            // --- ★ v13: BG (バックグラウンド) アクション ---
            case 'submit_bg_job':
                response = await handleSubmitBgJob(data, context);
                break;
            case 'check_bg_job':
                response = await handleCheckBgJob(data, context);
                break;

            // --- ★ v13: FG (フォアグラウンド) アクション ---
            case 'generate_fg': // 'generate' -> 'generate_fg' に変更
                const genApiKey = getApiKey(context, model, keyIndex);
                response = await handleGenerate_FG(data, genApiKey, context);
                break;
            case 'edit_fg': // 'edit' -> 'edit_fg' に変更
                 if (model === 'gemini-2.5-flash-image-preview' || model === 'gemini-2.0-flash-preview-image-generation') {
                    const editApiKey = getApiKey(context, model, keyIndex);
                    response = await handleEdit_FG(data, editApiKey, context);
                } else {
                    response = new Response(JSON.stringify({ error: 'Invalid model for FG editing' }), { status: 400 });
                }
                break;
                
            default:
                response = new Response(JSON.stringify({ error: 'Invalid action' }), { status: 400 });
        }
        return response;

    } catch (error) {
        // 予期せぬサーバーエラー
        console.error("Server Error:", error);
        // エラーをGASに記録 (サイレント)
        try {
            await handleErrorLog({
                prompt: data.prompt || data.jobPayload?.prompt || "N/A",
                model: data.model || "N/A",
                error: `Server Error: ${error.message}`
            }, context);
        } catch (logError) {
            console.error("Failed to log server error to GAS:", logError);
        }
        return new Response(JSON.stringify({ error: error.message || 'An unexpected error occurred' }), { status: 500 });
    }
}

// --- 共通ハンドラ ---

/**
 * 認証 (v12と同じ)
 */
async function handleAuth(data, context) {
    const { password } = data;
    const masterPassword = context.env.MUGEN_PASSWORD;

    if (!masterPassword) {
        console.error("MUGEN_PASSWORD environment variable is not set.");
        return new Response(JSON.stringify({ error: 'Server configuration error: Auth not set up.' }), { status: 500 });
    }
    if (!password) {
        return new Response(JSON.stringify({ error: 'Password is required' }), { status: 400 });
    }
    
    // 定数時間比較 (v12と同じ)
    let mismatch = 0;
    if (password.length !== masterPassword.length) {
        mismatch = 1;
    } else {
        for (let i = 0; i < password.length; i++) {
            mismatch |= (password.charCodeAt(i) ^ masterPassword.charCodeAt(i));
        }
    }
    if (mismatch !== 0) {
        return new Response(JSON.stringify({ error: 'Invalid password' }), { status: 401 });
    }

    return new Response(JSON.stringify({ success: true }), {
        headers: { 'Content-Type': 'application/json' },
    });
}


/**
 * 翻訳 (v12と同じ)
 */
async function handleTranslate(data, apiKey) {
    const { prompt } = data;
    if (!prompt) {
        return new Response(JSON.stringify({ error: 'Prompt is required' }), { status: 400 });
    }

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
        return new Response(JSON.stringify({ error: 'Failed to translate' }), { status: 500 });
    }

    const result = await response.json();
    const translatedPrompt = result.candidates[0].content.parts[0].text;
    
    return new Response(JSON.stringify({ translatedPrompt }), {
        headers: { 'Content-Type': 'application/json' },
    });
}

/**
 * エラーログ (v12と同じ)
 */
async function handleErrorLog(data, context) {
    const { prompt, model, error } = data;
    const gasUrl = context.env.GAS_WEB_APP_URL;

    if (!gasUrl) {
        console.warn("GAS_WEB_APP_URL is not set. Error logging failed.");
        return new Response(JSON.stringify({ error: 'GAS URL not configured' }), { status: 500 });
    }

    const saveData = {
        prompt: prompt,
        translatedPrompt: `[ERROR] ${error}`,
        base64Data: "ERROR",
        model: model,
        isError: true
    };

    try {
        await fetch(gasUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(saveData)
        });
        return new Response(JSON.stringify({ success: true }), { status: 200 });
    } catch (err) {
        console.error("GAS error logging failed:", err);
        return new Response(JSON.stringify({ error: 'Failed to log error to GAS' }), { status: 500 });
    }
}


// --- ★ v13: BG (バックグラウンド) ハンドラ ---

/**
 * BGジョブをKV (伝票置き場) に登録する
 */
async function handleSubmitBgJob(data, context) {
    const { kvBinding, jobId, model, keyIndex, jobPayload } = data;

    if (!context.env.MUGEN_KV) {
         return new Response(JSON.stringify({ error: 'KV (MUGEN_KV) is not bound to this Function.' }), { status: 500 });
    }
    
    if (!jobId || !model || !jobPayload) {
        return new Response(JSON.stringify({ error: 'Missing required job data (jobId, model, jobPayload)' }), { status: 400 });
    }

    const kvKey = `job:${jobId}`;
    const kvValue = {
        jobId: jobId,
        model: model,
        keyIndex: keyIndex, // シェフが使うAPIキーのインデックス
        jobPayload: jobPayload, // (prompt, aspectRatio, styles, baseImage)
        retryCount: 0, // リトライ回数
        submittedAt: new Date().toISOString()
    };

    try {
        // KVにジョブを保存 (有効期限 1時間)
        await context.env.MUGEN_KV.put(kvKey, JSON.stringify(kvValue), { expirationTtl: 3600 });
        
        console.log(`BG Job submitted: ${kvKey}`);
        
        return new Response(JSON.stringify({ success: true, jobId: jobId }), {
            headers: { 'Content-Type': 'application/json' },
        });

    } catch (error) {
        console.error(`Failed to submit job to KV (${kvKey}):`, error);
        return new Response(JSON.stringify({ error: 'Failed to submit job to KV' }), { status: 500 });
    }
}

/**
 * BGジョブの結果をKV (受け渡し口) から確認する
 */
async function handleCheckBgJob(data, context) {
    const { jobId } = data;

    if (!context.env.MUGEN_KV) {
         return new Response(JSON.stringify({ error: 'KV (MUGEN_KV) is not bound to this Function.' }), { status: 500 });
    }
    
    if (!jobId) {
        return new Response(JSON.stringify({ error: 'Missing jobId' }), { status: 400 });
    }

    const resultKey = `result:${jobId}`;

    try {
        // 1. KVから結果を取得
        const resultData = await context.env.MUGEN_KV.get(resultKey, { type: "json" });

        if (resultData) {
            // 2. 結果が見つかった！
            console.log(`BG Job result found: ${resultKey}`);
            
            // 3. KVから結果を削除 (1回きりの取得)
            await context.env.MUGEN_KV.delete(resultKey);
            
            // 4. フロントに結果を返す
            return new Response(JSON.stringify(resultData), {
                headers: { 'Content-Type': 'application/json' },
            });
        } else {
            // 5. まだ結果がない (Pending)
            return new Response(JSON.stringify({ status: "pending" }), {
                headers: { 'Content-Type': 'application/json' },
            });
        }
    } catch (error) {
        console.error(`Failed to check job from KV (${resultKey}):`, error);
        return new Response(JSON.stringify({ error: 'Failed to check job result from KV' }), { status: 500 });
    }
}


// --- ★ v13: FG (フォアグラウンド) ハンドラ (v12からの流用) ---

/**
 * FG: Imagen 3.0 / 4.0 (v12の handleGenerate)
 */
async function handleGenerate_FG(data, apiKey, context) {
    const { prompt, aspectRatio, styles, model } = data;

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
            "safetySettings": {
                "violence": "BLOCK_NONE",
                "sexual": "BLOCK_NONE",
                "hate": "BLOCK_NONE",
                "dangerous": "BLOCK_NONE"
            }
        }
    };

    const response = await fetch(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });

    if (!response.ok) {
        const errorText = await response.text();
        console.error("Imagen API Error (FG):", errorText);
        // FGエラーもGASに送信
        await handleErrorLog({ prompt: enhancedPrompt, model: model, error: `Imagen API Error: ${errorText}` }, context);
        return new Response(JSON.stringify({ error: `Failed to generate image (Imagen): ${errorText}` }), { status: 500 });
    }

    const result = await response.json();
    
    if (!result.predictions || !result.predictions[0] || !result.predictions[0].bytesBase64Encoded) {
        console.error("Imagen API Error (FG): No image data", result);
        const errorMessage = "Imagen API Error: No image data returned.";
        await handleErrorLog({ prompt: enhancedPrompt, model: model, error: errorMessage }, context);
        return new Response(JSON.stringify({ error: errorMessage }), { status: 500 });
    }
    
    const base64 = result.predictions[0].bytesBase64Encoded;

    // FGでもGASに保存 (v12と同じ)
    const gasUrl = context.env.GAS_WEB_APP_URL;
    if (gasUrl) {
        const saveData = {
            prompt: prompt,
            translatedPrompt: enhancedPrompt, 
            base64Data: base64,
            model: model
        };
        // waitUntilで非同期に実行
        context.waitUntil(
            fetch(gasUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(saveData)
            }).catch(err => console.error("GAS save error (FG):", err))
        );
    }

    return new Response(JSON.stringify({ base64: base64, translatedPrompt: enhancedPrompt }), {
        headers: { 'Content-Type': 'application/json' },
    });
}

/**
 * FG: Gemini Flash Image (v12の handleEdit)
 */
async function handleEdit_FG(data, apiKey, context) {
    const { prompt, baseImage, model } = data; 
    
    const isEditMode = !!baseImage;

    let apiUrl;
    if (model === 'gemini-2.0-flash-preview-image-generation') {
        apiUrl = `${GEMINI_API_URL_FLASH_IMAGE_2_0}?key=${apiKey}`;
    } else {
        apiUrl = `${GEMINI_API_URL_FLASH_IMAGE_2_5}?key=${apiKey}`;
    }
    
    const userParts = [{ text: prompt }];
    if (isEditMode) {
        userParts.push({
            inlineData: { mimeType: "image/png", data: baseImage }
        });
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
        console.error("Gemini Edit API Error (FG):", errorText);
        await handleErrorLog({ prompt: prompt, model: model, error: `Gemini API Error: ${errorText}` }, context);
        return new Response(JSON.stringify({ error: `Failed to edit image (Gemini): ${errorText}` }), { status: 500 });
    }

    const result = await response.json();
    const base64 = result?.candidates?.[0]?.content?.parts?.find(p => p.inlineData)?.inlineData?.data;

    if (!base64) {
        console.error("Gemini Edit API Error (FG): No image data in response", result);
        const errorText = result?.candidates?.[0]?.content?.parts?.[0]?.text;
        let errorMessage;
        if (result?.candidates?.[0]?.finishReason === 'SAFETY') {
             errorMessage = `Edit failed: Image blocked due to safety settings.`;
        } else {
             errorMessage = `Edit failed: ${errorText || 'No image data returned'}`;
        }
        await handleErrorLog({ prompt: prompt, model: model, error: errorMessage }, context);
        return new Response(JSON.stringify({ error: errorMessage }), { status: 500 });
    }

    // FGでもGASに保存 (v12と同じ)
    const gasUrl = context.env.GAS_WEB_APP_URL;
    if (gasUrl) {
        const gasPrompt = isEditMode ? `[Edit] ${prompt}` : prompt;
        const saveData = {
            prompt: gasPrompt,
            translatedPrompt: gasPrompt,
            base64Data: base64,
            model: model 
        };
        context.waitUntil(
            fetch(gasUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(saveData)
            }).catch(err => console.error("GAS save error (FG):", err))
        );
    }

    return new Response(JSON.stringify({ base64: base64, translatedPrompt: prompt }), {
        headers: { 'Content-Type': 'application/json' },
    });
}
