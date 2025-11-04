/**
 * Cloudflare Function (Node.js)
 * Handles API requests for translation, image generation, and editing.
 * Deployed at /functions/api/generate.js
 */

const IMAGEN_API_URL_PREDICT = "https://generativelanguage.googleapis.com/v1beta/models/imagen-3.0-generate-002:predict";
const GEMINI_API_URL_FLASH = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-09-2025:generateContent";

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
        const { action } = data;

        // --- API Key Rotation ---
        // Uses the counter from the client (keyIndex)
        // (keyIndex % 10) gives 0-9. We add 1 for 1-10.
        const keyIndex = (data.keyIndex || 0) % 10 + 1;
        const apiKeyEnvVar = `GEMINI_API_KEY_${keyIndex.toString().padStart(2, '0')}`;
        const apiKey = context.env[apiKeyEnvVar];

        if (!apiKey) {
            console.error(`Missing API Key: ${apiKeyEnvVar}`);
            return new Response(JSON.stringify({ error: `Server configuration error: Missing API Key (${apiKeyEnvVar})` }), { status: 500 });
        }

        let response;
        switch (action) {
            case 'translate':
                response = await handleTranslate(data, apiKey);
                break;
            case 'generate':
                response = await handleGenerate(data, apiKey, context);
                break;
            case 'edit':
                response = await handleEdit(data, apiKey, context);
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
            // "aspectRatio": aspectRatio, // This might not be a parameter for 'predict'
            "sampleCount": 1,
            // Safety/Filter settings (minimal blocking as requested)
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
        return new Response(JSON.stringify({ error: `Failed to generate image (Imagen): ${errorText}` }), { status: 500 });
    }

    const result = await response.json();
    const base64 = result.predictions[0].bytesBase64Encoded;

    // --- Asynchronously save to GAS ---
    const gasUrl = context.env.GAS_WEB_APP_URL;
    if (gasUrl) {
        const saveData = {
            prompt: prompt,
            translatedPrompt: enhancedPrompt, // Save the full prompt
            base64Data: base64,
            model: "imagen-3.0-generate"
        };
        // Don't wait for this to finish, let the response go back to the user
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
 * Edits an image using Gemini 2.5 Flash
 */
async function handleEdit(data, apiKey, context) {
    const { prompt, baseImage } = data; // prompt is the edit instruction
    
    if (!baseImage) {
        return new Response(JSON.stringify({ error: 'Base image is required for editing' }), { status: 400 });
    }

    const apiUrl = `${GEMINI_API_URL_FLASH}?key=${apiKey}`;

    // Gemini 2.5 Flash Image payload
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
            responseModalities: ['TEXT', 'IMAGE'],
            // Safety/Filter settings (minimal blocking)
            safetySettings: [
                { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
                { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
                { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
                { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" }
            ]
        },
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
        return new Response(JSON.stringify({ error: `Edit failed: ${errorText || 'No image data returned'}` }), { status: 500 });
    }

    // --- Asynchronously save to GAS ---
    const gasUrl = context.env.GAS_WEB_APP_URL;
    if (gasUrl) {
        const saveData = {
            prompt: `[Edit] ${prompt}`,
            translatedPrompt: `[Edit] ${prompt}`,
            base64Data: base64,
            model: "gemini-2.5-flash-image"
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
