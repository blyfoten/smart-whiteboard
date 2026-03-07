// server.js
require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const math = require('mathjs');
const cors = require('cors');
const path = require('path');
const axios = require('axios');
// Import the Google AI library (will need to be installed using npm)
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();
const PORT = process.env.PORT || 3000;

// Initialize the Gemini API client
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Middleware
app.use(bodyParser.json({ limit: '10mb' })); // Increase size limit for large images
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

// Function to solve equation with GPT API
async function solveEquationWithGPT(equation) {
    try {
        const gptResponse = await axios.post(
            'https://api.openai.com/v1/chat/completions',
            {
                model: 'gpt-4', // Or another available model with mathematical capabilities
                messages: [
                    { role: 'system', content: 'You are a mathematical assistant.' },
                    { role: 'user', content: `Solve the equation: ${equation}` }
                ]
            },
            {
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
                }
            }
        );

        const solution = gptResponse.data.choices[0].message.content.trim();
        return solution;
    } catch (error) {
        console.error('Error in solveEquationWithGPT:', error.response ? error.response.data : error.message);
        return null;
    }
}

// Function to solve equation with Gemini API
async function solveEquationWithGemini(equation) {
    try {
        console.log(`Solving equation with Gemini: ${equation}`);
        
        // Get the model
        const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
        
        // Create a more specific prompt
        const prompt = `You are a mathematical assistant. Solve the equation: ${equation}

Please provide a clear, concise solution. Don't use markdown formatting in your response.
Simply start with "The solution is:" followed by the answer.`;
        
        // Generate content
        const result = await model.generateContent(prompt);
        const response = await result.response;
        let solution = response.text();
        
        console.log(`Raw Gemini solution response: ${solution}`);
        
        // Extract just the solution part if it follows our format
        if (solution.includes("The solution is:")) {
            solution = solution.split("The solution is:")[1].trim();
            console.log(`Extracted solution: ${solution}`);
        } else {
            console.log(`Solution format not found, using full response`);
        }
        
        return solution;
    } catch (error) {
        console.error('Error in solveEquationWithGemini:', error);
        if (error.response) {
            console.error('Gemini API response error:', error.response);
        }
        return null;
    }
}

// API endpoint to extract equation from canvas
app.post('/extract-equation', async (req, res) => {
    const { image } = req.body;

    if (!image) {
        return res.json({ success: false, message: 'No image received.' });
    }

    try {
        // Send image to OpenAI Vision API
        const openAIResponse = await axios.post(
            'https://api.openai.com/v1/chat/completions',
            {
                "model": "gpt-4o",
                "response_format": { "type": "json_object" }, // Enforce JSON response format
                "messages": [
                  {
                    "role": "system",
                    "content": [
                        {
                            "type": "text",
                            "text": `You are an AI specialized in interpreting handwritten mathematical equations from images and converting them into structured JSON suitable for math.js.

Your task is to analyze the image and extract the mathematical equation, then return a properly structured JSON response.

IMPORTANT REQUIREMENTS:
1. Return ONLY valid JSON without any markdown formatting, explanatory text, or code blocks
2. Do not include backticks (\`\`\`) or "json" tags around your response
3. Ensure all JSON is properly formatted and can be parsed with JSON.parse()

JSON SCHEMA:
{
  "dependentVariable": "string", // Variable on the left side of the equation (e.g., "y")
  "expression": "string",        // Right side of the equation in math.js format (e.g., "x^2 + 3*x")
  "scope": {                     // Sample values for each variable
    "variableName": number       // e.g., "x": 0
  },
  "ranges": {                    // Min/max values for plotting each variable
    "variableName": [number, number] // e.g., "x": [-10, 10]
  }
}

If you cannot interpret the equation, return exactly:
{"error": "Unable to interpret the handwritten equation. Please ensure the handwriting is clear."}`
                        }
                    ]
                  },
                  {
                    "role": "user",
                    "content": [
                      {
                        "type": "image_url",
                        "image_url": {
                          "url": image
                        }
                      }
                    ]
                  }
                ],
                "max_tokens": 500
            },
            {
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
                }
            }
        );

        // Extract and parse the JSON response
        let jsonContent = openAIResponse.data.choices[0].message.content.trim();
        
        // Log the raw response for debugging
        console.log("Raw OpenAI response:", jsonContent);
        
        // Handle any cleanup needed
        try {
            const extractedData = JSON.parse(jsonContent);
            
            if (extractedData.error) {
                return res.json({ success: false, message: extractedData.error });
            }
            
            // Validate required fields
            if (!extractedData.expression || !extractedData.dependentVariable || 
                !extractedData.scope || !extractedData.ranges) {
                return res.json({ 
                    success: false, 
                    message: 'Invalid response format: missing required fields.' 
                });
            }

            res.json({ 
                success: true, 
                equation: extractedData.expression,
                dependentVariable: extractedData.dependentVariable,
                scope: extractedData.scope,
                ranges: extractedData.ranges
            });
        } catch (parseError) {
            console.error('JSON parse error:', parseError);
            console.error('Raw content received:', jsonContent);
            return res.json({ 
                success: false, 
                message: 'Failed to parse the response as JSON. Please try again.' 
            });
        }
    } catch (error) {
        console.error('Error in /extract-equation:', error.response ? error.response.data : error.message);
        res.json({ success: false, message: 'Error processing the image.' });
    }
});

// API endpoint to solve equations with selected model
app.post('/solve', async (req, res) => {
    const { equation, model = 'math' } = req.body;
    console.log(`===== SOLVE REQUEST =====`);
    console.log(`Equation: "${equation}"`);
    console.log(`Model: ${model}`);
    console.log(`Request body: ${JSON.stringify(req.body)}`);
    
    try {
        // Use math.js by default (for simple equations)
        if (model === 'math') {
            console.log(`Using Math.js for equation: ${equation}`);
            const result = math.evaluate(equation);
            console.log(`Math.js result: ${result}`);
            res.json({ success: true, result });
        } 
        // Use GPT for complex equations
        else if (model === 'gpt') {
            console.log(`Using GPT for equation: ${equation}`);
            const result = await solveEquationWithGPT(equation);
            if (result) {
                console.log(`GPT result: ${result}`);
                res.json({ success: true, result });
            } else {
                console.error(`GPT failed to solve equation: ${equation}`);
                res.json({ success: false, message: 'Error solving equation with GPT.' });
            }
        }
        // Use Gemini for complex equations
        else if (model === 'gemini') {
            console.log(`Using Gemini for equation: ${equation}`);
            const result = await solveEquationWithGemini(equation);
            if (result) {
                console.log(`Gemini result: ${result}`);
                res.json({ success: true, result });
            } else {
                console.error(`Gemini failed to solve equation: ${equation}`);
                res.json({ success: false, message: 'Error solving equation with Gemini.' });
            }
        }
        else {
            console.error(`Invalid model specified: ${model}`);
            res.json({ success: false, message: 'Invalid model specified.' });
        }
    } catch (error) {
        console.error(`Error processing equation "${equation}" with model ${model}:`, error);
        res.json({ success: false, message: `Error solving equation: ${error.message}` });
    }
});

// Add a new endpoint for extracting equation with Gemini
app.post('/extract-equation-gemini', async (req, res) => {
    const { image } = req.body;

    if (!image) {
        return res.json({ success: false, message: 'No image received.' });
    }

    try {
        // Initialize Gemini model - removing the unsupported responseSchema
        const model = genAI.getGenerativeModel({ 
            model: "gemini-2.0-flash"
        });
        
        // Prepare the prompt with system instructions
        const systemPrompt = `You are an AI specialized in interpreting handwritten mathematical equations from images and converting them into structured JSON suitable for math.js.

Your task is to analyze the image and extract the mathematical equation, then return a properly structured JSON response.

IMPORTANT REQUIREMENTS:
1. Return ONLY valid JSON without any markdown formatting, explanatory text, or code blocks
2. Do not include backticks (\`\`\`) or "json" tags around your response
3. Ensure all JSON is properly formatted and can be parsed with JSON.parse()

The JSON must follow this schema exactly:
{
  "dependentVariable": "string", // Variable on the left side of the equation (e.g., "y")
  "expression": "string",        // Right side of the equation in math.js format (e.g., "x^2 + 3*x")
  "scope": {                     // Sample values for each variable
    "variableName": number       // e.g., "x": 0
  },
  "ranges": {                    // Min/max values for plotting each variable
    "variableName": [number, number] // e.g., "x": [-10, 10]
  }
}

Example of good response:
{"dependentVariable":"y","expression":"x^2+3*x-5","scope":{"x":0},"ranges":{"x":[-10,10]}}

If you cannot interpret the equation, return exactly:
{"error": "Unable to interpret the handwritten equation. Please ensure the handwriting is clear."}`;

        // Convert base64 image to parts for Gemini
        const imageData = image.split(',')[1]; // Remove the data:image/png;base64, part
        const imagePart = {
            inlineData: {
                data: imageData,
                mimeType: "image/png"
            }
        };
        
        // Generate content
        const result = await model.generateContent([systemPrompt, imagePart]);
        const response = await result.response;
        const content = response.text();

        // Extract JSON from Markdown-formatted response if needed
        let jsonString = content;

        // Function to extract JSON from Markdown code blocks
        function extractJsonFromMarkdown(text) {
            // Check for code blocks with json or JSON tag
            const jsonCodeBlockRegex = /```(?:json|JSON)?\s*([\s\S]*?)```/;
            const match = text.match(jsonCodeBlockRegex);
            
            if (match && match[1]) {
                return match[1].trim();
            }
            
            // Try to find JSON without code blocks by looking for opening brace
            const jsonStart = text.indexOf('{');
            const jsonEnd = text.lastIndexOf('}');
            if (jsonStart !== -1 && jsonEnd !== -1 && jsonEnd > jsonStart) {
                return text.substring(jsonStart, jsonEnd + 1);
            }
            
            return text; // Return original if no code blocks found
        }

        // Clean up the response
        jsonString = extractJsonFromMarkdown(jsonString);
        console.log('Raw Gemini response:', content);
        console.log('Cleaned JSON string:', jsonString);

        try {
            // Parse the JSON response
            const extractedData = JSON.parse(jsonString);

            if (extractedData.error) {
                return res.json({ success: false, message: extractedData.error });
            }
            
            // Validate required fields
            if (!extractedData.expression || !extractedData.dependentVariable || 
                !extractedData.scope || !extractedData.ranges) {
                return res.json({ 
                    success: false, 
                    message: 'Invalid response format: missing required fields.' 
                });
            }

            res.json({ 
                success: true, 
                equation: extractedData.expression,
                dependentVariable: extractedData.dependentVariable,
                scope: extractedData.scope,
                ranges: extractedData.ranges
            });
        } catch (parseError) {
            console.error('JSON Parse Error:', parseError);
            console.error('Raw content received:', content);
            return res.json({ 
                success: false, 
                message: 'Failed to parse the response from Gemini API. Please try again.' 
            });
        }

    } catch (error) {
        console.error('Error in /extract-equation-gemini:', error);
        res.json({ success: false, message: 'Error processing the image with Gemini.' });
    }
});

// Adjust the /graph endpoint
app.post('/graph', (req, res) => {
    const { expression, dependentVariable, scope, ranges } = req.body;
    const variable = Object.keys(scope)[0]; // Assume first variable in scope is the one to plot
    const [start, end] = ranges[variable];
    const step = (end - start) / 100; // 100 points for the graph

    try {
        const expr = math.parse(expression).compile();
        let data = [];

        for (let x = start; x <= end; x += step) {
            let currentScope = { ...scope, [variable]: x };
            let y = expr.evaluate(currentScope);
            if (typeof y === 'number' && isFinite(y)) {
                data.push({ x, y });
            }
        }

        res.json({ success: true, data, dependentVariable });
    } catch (error) {
        res.json({ success: false, message: 'Invalid equation or parameters.' });
    }
});

// Start the server with port fallback
function startServer(port) {
    app.listen(port)
        .on('error', (err) => {
            if (err.code === 'EADDRINUSE') {
                console.log(`Port ${port} is already in use, trying port ${port + 1}...`);
                startServer(port + 1);
            } else {
                console.error('Error starting server:', err);
            }
        })
        .on('listening', () => {
            console.log(`Server running on http://localhost:${port}`);
        });
}

// Start the server with initial port
startServer(PORT);
