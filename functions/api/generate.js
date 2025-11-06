/**
 * Cloudflare Function (Node.js)
 * Handles API requests for translation, image generation, and editing.
 * Deployed at /functions/api/generate.js
 */

const IMAGEN_API_URL_PREDICT = "https://generativelanguage.googleapis.com/v1beta/models/imagen-3.0-generate-002:predict";
// ★ 変更: モデル名を 'gemini-2.5-flash-image-preview' に
const GEMINI_API_URL_FLASH_IMAGE = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image-preview:generateContent";
const GEMINI_API_URL_FLASH = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-09-2025:generateContent";


/**
 * APIキーを取得する
 * (Cloudflare Envから)
 */
function getApiKey(context, model, keyIndex) {
    const keyPoolSize = 10; // 01から10までのキー
    const index = (keyIndex || 0) % keyPoolSize + 1;
    const keyIndexStr = index.toString().padStart(2, '0');
    
    let apiKeyEnvVar;
    
    // ★ 変更: モデルに応じてキー変数を切り替え
    if (model === 'gemini-2.5-flash-image-preview') {
        apiKeyEnvVar = `GEMINI_FLASH_IMAGE_API_KEY_${keyIndexStr}`;
    } else {
        // デフォルト (Imagen / Translate)
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
 * Handles all POST requests
 * @param {EventContext} context - Cloudflare context (contains env, request)
 */
export async function onRequest(context) {
    if (context.request.method !== 'POST') {
        return new Response(JSON.stringify({ error: 'Method Not Allowed' }), { status: 405 });
    }

    try {
        const data = await context.request.json();
        const { action, model, keyIndex } = data;

        // ★ 追加: エラーロギングアクション
        if (action === 'logError') {
            return await handleErrorLog(data, context);
        }

        // ★ 追加: 認証アクション
        if (action === 'auth') {
            return await handleAuth(data, context);
        }

        // --- ここから先の操作は認証が必要 ---
        // ※ 本来はここでトークン検証などを行うが、
        // ※ 今回はフロントの sessionStorage に依存するためサーバー側での強制チェックは省略

        // ★ 変更: アクションとモデルに応じてAPIキーを取得
        const apiKey = getApiKey(context, model, keyIndex);

        let response;
        switch (action) {
            case 'translate':
                // 翻訳はデフォルトキー (GEMINI_API_KEY_XX) を使用
                const translateApiKey = getApiKey(context, 'default', keyIndex);
                response = await handleTranslate(data, translateApiKey);
                break;
            case 'generate':
                if (model === 'imagen-3.0-generate') {
                    response = await handleGenerate(data, apiKey, context);
                } else if (model === 'gemini-2.5-flash-image-preview') {
                    // Gemini Flash Image も 'generate' アクションとして扱われる (編集モードでない場合)
                    response = await handleEdit(data, apiKey, context); // 編集用関数を流用
                } else {
                    response = new Response(JSON.stringify({ error: 'Invalid model for generation' }), { status: 400 });
                }
                break;
            case 'edit':
                 if (model === 'gemini-2.5-flash-image-preview') {
                    response = await handleEdit(data, apiKey, context);
                } else {
                    response = new Response(JSON.stringify({ error: 'Invalid model for editing' }), { status: 400 });
                }
                break;
            default:
                response = new Response(JSON.stringify({ error: 'Invalid action' }), { status: 400 });
        }
        return response;

    } catch (error) {
        console.error("Server Error:", error);
        // ★ 変更: サーバー側での予期せぬエラーもGASに記録
        try {
            const data = await context.request.json().catch(() => ({})); // ボディ取得試行
            await handleErrorLog({
                prompt: data.prompt || "N/A",
                model: data.model || "N/A",
                error: `Server Error: ${error.message}`
            }, context);
        } catch (logError) {
            console.error("Failed to log server error to GAS:", logError);
        }
        return new Response(JSON.stringify({ error: error.message || 'An unexpected error occurred' }), { status: 500 });
    }
}

// --- Action Handlers ---

/**
 * ★ 追加: パスワード認証を処理する
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

    // ★ 定数時間比較 (一応)
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

    // 認証成功
    return new Response(JSON.stringify({ success: true }), {
        headers: { 'Content-Type': 'application/json' },
    });
}


/**
 * Translates text to English using Gemini Flash
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
        systemInstruction: {
            parts: [{ text: systemPrompt }]
        },
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
 * Generates an image using Imagen 3.0
 */
async function handleGenerate(data, apiKey, context) {
    // ★ 修正: model を data から取得
    const { prompt, aspectRatio, styles, model } = data;

    // Enhance prompt
    let enhancedPrompt = prompt;
    if (styles && styles.length > 0) {
        enhancedPrompt += `, ${styles.join(', ')} style`;
    }

    const apiUrl = `${IMAGEN_API_URL_PREDICT}?key=${apiKey}`;
    
    const payload = {
        instances: {
            prompt: enhancedPrompt
        },
        parameters: {
            "aspectRatio": aspectRatio, // ★ 修正: アスペクト比をパラメータとして設定
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
        console.error("Imagen API Error:", errorText);
        // ★ 追加: エラーをGASに送信
        await handleErrorLog({ prompt: enhancedPrompt, model: model, error: `Imagen API Error: ${errorText}` }, context);
        return new Response(JSON.stringify({ error: `Failed to generate image (Imagen): ${errorText}` }), { status: 500 });
    }

    const result = await response.json();
    const base64 = result.predictions[0].bytesBase64Encoded;

    // --- Asynchronously save to GAS ---
    const gasUrl = context.env.GAS_WEB_APP_URL;
    if (gasUrl) {
        const saveData = {
            prompt: prompt,
            translatedPrompt: enhancedPrompt, 
            base64Data: base64,
            model: model 
        };
        context.waitUntil(
            fetch(gasUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(saveData)
            }).catch(err => console.error("GAS save error:", err))
        );
    }
    // ---------------------------------

    return new Response(JSON.stringify({ base64: base64, translatedPrompt: enhancedPrompt }), {
        headers: { 'Content-Type': 'application/json' },
    });
}

/**
 * Edits (or generates) an image using Gemini 2.5 Flash Image
 */
async function handleEdit(data, apiKey, context) {
    // ★ 修正: aspectRatio と model を data から取得
    const { prompt, baseImage, aspectRatio, model } = data; 
    
    // 'edit' (baseImageあり) or 'generate' (baseImageなし)
    const isEditMode = !!baseImage;

    const apiUrl = `${GEMINI_API_URL_FLASH_IMAGE}?key=${apiKey}`;
    
    // ユーザーが送信するパーツ
    const userParts = [{ text: prompt }];
    
    if (isEditMode) {
        userParts.push({
            inlineData: {
                mimeType: "image/png",
                data: baseImage
            }
        });
    }

    const payload = {
        contents: [
            {
                role: "user",
                parts: userParts
            }
        ],
        generationConfig: {
            responseModalities: ['TEXT', 'IMAGE']
        },
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
        console.error("Gemini Edit API Error:", errorText);
        // ★ 追加: エラーをGASに送信
        await handleErrorLog({ prompt: prompt, model: model, error: `Gemini API Error: ${errorText}` }, context);
        return new Response(JSON.stringify({ error: `Failed to edit image (Gemini): ${errorText}` }), { status: 500 });
    }

    const result = await response.json();
    const base64 = result?.candidates?.[0]?.content?.parts?.find(p => p.inlineData)?.inlineData?.data;

    if (!base64) {
        console.error("Gemini Edit API Error: No image data in response", result);
        const errorText = result?.candidates?.[0]?.content?.parts?.[0]?.text;
        let errorMessage;
        if (result?.candidates?.[0]?.finishReason === 'SAFETY') {
             errorMessage = `Edit failed: Image blocked due to safety settings.`;
        } else {
             errorMessage = `Edit failed: ${errorText || 'No image data returned'}`;
        }
        // ★ 追加: エラーをGASに送信
        await handleErrorLog({ prompt: prompt, model: model, error: errorMessage }, context);
        return new Response(JSON.stringify({ error: errorMessage }), { status: 500 });
    }

    // --- Asynchronously save to GAS ---
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
            }).catch(err => console.error("GAS save error:", err))
        );
    }
    // ---------------------------------

    return new Response(JSON.stringify({ base64: base64, translatedPrompt: prompt }), {
        headers: { 'Content-Type': 'application/json' },
    });
}

