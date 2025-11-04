/**
 * Cloudflare Function (Node.js)
 * Handles API requests for translation, image generation, and editing.
 * Deployed at /functions/api/generate.js
 */

// --- API Endpoints ---
const IMAGEN_API_URL_PREDICT = "https://generativelanguage.googleapis.com/v1beta/models/imagen-3.0-generate-002:predict";
const GEMINI_API_URL_TRANSLATE = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-09-2025:generateContent";
// ★ 変更: gemini-2.5-flash-image-preview のエンドポイントを追加
const GEMINI_API_URL_FLASH_IMAGE = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image-preview:generateContent";

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
        const { action, model } = data; // 'model' をリクエストから取得

        // --- API Key Selection ---
        // ★ 変更: action と model に基づいて使用する API キー (環境変数) を切り替える
        
        const keyIndex = (data.keyIndex || 0) % 10 + 1;
        let apiKeyEnvVar;
        let apiKey;

        if (action === 'translate') {
            // 翻訳: 従来のキーを使用
            apiKeyEnvVar = `GEMINI_API_KEY_${keyIndex.toString().padStart(2, '0')}`;
            apiKey = context.env[apiKeyEnvVar];
        } else if (action === 'generate' && model === 'imagen-3.0-generate') {
            // Imagen 3.0 生成: 従来のキーを使用
            apiKeyEnvVar = `GEMINI_API_KEY_${keyIndex.toString().padStart(2, '0')}`;
            apiKey = context.env[apiKeyEnvVar];
        } else if (action === 'edit' || (action === 'generate' && model === 'gemini-2.5-flash-image-preview')) {
            // 編集 または Gemini Flash Image 生成: ★ 専用の新しいキーを使用
            apiKeyEnvVar = `GEMINI_FLASH_IMAGE_API_KEY_${keyIndex.toString().padStart(2, '0')}`;
            apiKey = context.env[apiKeyEnvVar];
        } else {
            // フォールバック (従来の Imagen 3.0 生成)
            apiKeyEnvVar = `GEMINI_API_KEY_${keyIndex.toString().padStart(2, '0')}`;
            apiKey = context.env[apiKeyEnvVar];
        }

        if (!apiKey) {
            console.error(`Missing API Key: ${apiKeyEnvVar}`);
            return new Response(JSON.stringify({ error: `Server configuration error: Missing API Key (${apiKeyEnvVar})` }), { status: 500 });
        }
        // --- End of API Key Selection ---

        let response;
        switch (action) {
            case 'translate':
                response = await handleTranslate(data, apiKey);
                break;
            case 'generate':
                // ★ 変更: 'model' に応じて内部関数を呼び分ける
                if (model === 'gemini-2.5-flash-image-preview') {
                    response = await handleGenerateWithFlashImage(data, apiKey, context);
                } else {
                    // デフォルトは Imagen 3.0
                    response = await handleGenerateWithImagen(data, apiKey, context);
                }
                break;
            case 'edit':
                // 編集は常に Gemini Flash Image を使用
                response = await handleEditWithFlashImage(data, apiKey, context);
                break;
            default:
                response = new Response(JSON.stringify({ error: 'Invalid action' }), { status: 400 });
        }
        return response;

    } catch (error) {
        console.error("Server Error:", error);
        return new Response(JSON.stringify({ error: error.message || 'An unexpected error occurred' }), { status: 500 });
    }
}

// --- Action Handlers ---

/**
 * Translates text to English using Gemini Flash (for translation)
 */
async function handleTranslate(data, apiKey) {
    const { prompt } = data;
    if (!prompt) {
        return new Response(JSON.stringify({ error: 'Prompt is required' }), { status: 400 });
    }

    const systemPrompt = "You are a translation assistant. Translate the following text into a clear, effective, and creative English prompt for an AI image generator. If the input is already in English, refine it for clarity and creative potential.";
    const userQuery = `Translate and refine: "${prompt}"`;
    const apiUrl = `${GEMINI_API_URL_TRANSLATE}?key=${apiKey}`; // 翻訳用モデル

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
 * ★ 元の handleGenerate を Imagen 3.0 専用にリネーム
 * Generates an image using Imagen 3.0
 */
async function handleGenerateWithImagen(data, apiKey, context) {
    const { prompt, aspectRatio, styles } = data;

    // Enhance prompt
    let enhancedPrompt = prompt;
    if (styles && styles.length > 0) {
        enhancedPrompt += `, ${styles.join(', ')} style`;
    }
    enhancedPrompt += `, aspect ratio ${aspectRatio}`;

    const apiUrl = `${IMAGEN_API_URL_PREDICT}?key=${apiKey}`;
    
    // Imagen 3.0 'predict' payload
    const payload = {
        instances: {
            prompt: enhancedPrompt
        },
        parameters: {
            "sampleCount": 1,
            "safetySettings": {
                "violence": "BLOCK_NONE",
                "sexual": "BLOCK_NONE",
                "hate": "BLOCK_NONE",
                "dangerous": "BLOCK_NONE"
            }
        }
    };
    // ... (fetch, GAS保存ロジックは変更なし) ...
    const response = await fetch(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });

    if (!response.ok) {
        const errorText = await response.text();
        console.error("Imagen API Error:", errorText);
        return new Response(JSON.stringify({ error: `Failed to generate image (Imagen): ${errorText}` }), { status: 500 });
    }

    const result = await response.json();
    const base64 = result.predictions[0].bytesBase64Encoded;

    const gasUrl = context.env.GAS_WEB_APP_URL;
    if (gasUrl) {
        const saveData = {
            prompt: prompt,
            translatedPrompt: enhancedPrompt,
            base64Data: base64,
            model: "imagen-3.0-generate" // モデル名を明記
        };
        context.waitUntil(
            fetch(gasUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(saveData)
            }).catch(err => console.error("GAS save error:", err))
        );
    }

    return new Response(JSON.stringify({ base64: base64, translatedPrompt: enhancedPrompt }), {
        headers: { 'Content-Type': 'application/json' },
    });
}

/**
 * ★ 新規: Gemini 2.5 Flash Image を使った「生成」
 * Generates an image using Gemini 2.5 Flash Image
 */
async function handleGenerateWithFlashImage(data, apiKey, context) {
    const { prompt, aspectRatio, styles } = data;
        
    let enhancedPrompt = prompt;
    if (styles && styles.length > 0) {
        enhancedPrompt += `, ${styles.join(', ')} style`;
    }
    // Gemini Flash Image はアスペクト比をプロンプトに含める
    enhancedPrompt += `, aspect ratio ${aspectRatio}`;

    const apiUrl = `${GEMINI_API_URL_FLASH_IMAGE}?key=${apiKey}`;

    // Gemini 2.5 Flash Image (Generation) payload
    const payload = {
        contents: [
            {
                role: "user",
                parts: [
                    { text: enhancedPrompt } // Prompt for generation
                ]
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
        console.error("Gemini Generate API Error:", errorText);
        return new Response(JSON.stringify({ error: `Failed to generate image (Gemini): ${errorText}` }), { status: 500 });
    }

    const result = await response.json();
    const base64 = result?.candidates?.[0]?.content?.parts?.find(p => p.inlineData)?.inlineData?.data;

    if (!base64) {
        console.error("Gemini Generate API Error: No image data in response", result);
        const errorText = result?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (result?.candidates?.[0]?.finishReason === 'SAFETY') {
             return new Response(JSON.stringify({ error: `Generate failed: Image blocked due to safety settings.` }), { status: 500 });
        }
        return new Response(JSON.stringify({ error: `Generate failed: ${errorText || 'No image data returned'}` }), { status: 500 });
    }

    // --- Asynchronously save to GAS ---
    const gasUrl = context.env.GAS_WEB_APP_URL;
    if (gasUrl) {
        const saveData = {
            prompt: prompt,
            translatedPrompt: enhancedPrompt,
            base64Data: base64,
            model: "gemini-2.5-flash-image-preview" // ★ モデル名を明記
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
 * ★ 元の handleEdit を Gemini Flash Image 専用にリネーム・修正
 * Edits an image using Gemini 2.5 Flash Image
 */
async function handleEditWithFlashImage(data, apiKey, context) {
    const { prompt, baseImage } = data; // prompt is the edit instruction
    
    if (!baseImage) {
        return new Response(JSON.stringify({ error: 'Base image is required for editing' }), { status: 400 });
    }

    // ★ 変更: gemini-2.5-flash-image-preview のエンドポイントを使用
    const apiUrl = `${GEMINI_API_URL_FLASH_IMAGE}?key=${apiKey}`;

    // Gemini 2.5 Flash Image (Edit) payload
    const payload = {
        contents: [
            {
                role: "user",
                parts: [
                    { text: prompt }, // Edit instruction
                    {
                        inlineData: {
                            mimeType: "image/png",
                            data: baseImage
                        }
                    }
                ]
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
        return new Response(JSON.stringify({ error: `Failed to edit image (Gemini): ${errorText}` }), { status: 500 });
    }

    const result = await response.json();
    const base64 = result?.candidates?.[0]?.content?.parts?.find(p => p.inlineData)?.inlineData?.data;

    if (!base64) {
        console.error("Gemini Edit API Error: No image data in response", result);
        const errorText = result?.candidates?.[0]?.content?.parts?.[0]?.text;
        // Check for safety rating blocks
        if (result?.candidates?.[0]?.finishReason === 'SAFETY') {
             return new Response(JSON.stringify({ error: `Edit failed: Image blocked due to safety settings.` }), { status: 500 });
        }
        return new Response(JSON.stringify({ error: `Edit failed: ${errorText || 'No image data returned'}` }), { status: 500 });
    }

    // --- Asynchronously save to GAS ---
    const gasUrl = context.env.GAS_WEB_APP_URL;
    if (gasUrl) {
        const saveData = {
            prompt: `[Edit] ${prompt}`,
            translatedPrompt: `[Edit] ${prompt}`,
            base64Data: base64,
            model: "gemini-2.5-flash-image-preview" // ★ モデル名を明記
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

    return new Response(JSON.stringify({ base64: base64, translatedPrompt: `[Edit] ${prompt}` }), {
        headers: { 'Content-Type': 'application/json' },
    });
}
