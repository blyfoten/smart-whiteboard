// server.js
require('dotenv').config(); // Load environment variables from .env
console.log('OpenAI API Key:', process.env.OPENAI_API_KEY);
const express = require('express');
const bodyParser = require('body-parser');
const math = require('mathjs');
const cors = require('cors');
const path = require('path');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

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

// API endpoint to extract equation from canvas
app.post('/extract-equation', async (req, res) => {
    const { image } = req.body;

    if (!image) {
        return res.json({ success: false, message: 'No image received.' });
    }

    try {
        // Extract Base64 string
        //const base64Data = image.replace(/^data:image\/png;base64,/, '');

        // Send image to OpenAI Vision API
        // Adjust URL and payload according to OpenAI Vision API specifications
        const openAIResponse = await axios.post(
            'https://api.openai.com/v1/chat/completions', // Replace with correct endpoint if necessary
            {
                "model": "gpt-4o",
                "messages": [
                  {
                    "role": "system",
                    "content": [
                        {
                            "type": "text",
                            "text": "You are an AI specialized in interpreting handwritten mathematical equations from images and converting them into structured JSON suitable for math.js.\n\nInput:\nAn image containing a handwritten mathematical equation.\n\nTasks:\n1. Extract Equation:\n- Accurately extract the handwritten equation from the image.\n\n2. Convert to math.js Expression:\n- Translate the extracted equation into a math.js compatible expression string.\n\n3. Identify Dependent Variable:\n- Determine the dependent variable in the equation.\n\n4. Define Scope:\n- Assign sample values to each independent variable.\n\n5. Suggest Variable Ranges:\n- Provide appropriate ranges for independent variables for graphical plotting.\n\nOutput Format:\nReturn only a JSON object with the following keys:\n- \"dependentVariable\": String indicating the dependent variable.\n- \"expression\": String representing the math.js compatible expression.\n- \"scope\": Object mapping each independent variable to a sample value.\n- \"ranges\": Object mapping each independent variable to an [min, max] array.\n\nExample Output:\n{\n  \"dependentVariable\": \"y\",\n  \"expression\": \"(x - 1) * (x - 4)\",\n  \"scope\": {\n    \"x\": 0\n  },\n  \"ranges\": {\n    \"x\": [-10, 10]\n  }\n}\n\nAdditional Guidelines:\n- **Output Only JSON:**\nDo not include any explanatory text or comments. The response must contain solely the JSON object.\n\n- **Precision:**\nUse precise numerical values, especially for constants (e.g., use Math.PI if applicable).\n\n- **Error Handling:**\nIf extraction or conversion fails, return a JSON with an \"error\" key describing the issue.\n\n**Error Example:**\n{\n  \"error\": \"Unable to parse the handwritten equation. Please ensure the handwriting is clear and follows standard mathematical notation.\"\n}"
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
                "max_tokens": 300
              },
            {
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
                }
            }
        );

        // Assume the API response contains a "text" field with the extracted text
        const extractedData = JSON.parse(openAIResponse.data.choices[0].message.content);

        if (extractedData.error) {
            return res.json({ success: false, message: extractedData.error });
        }

        res.json({ 
            success: true, 
            equation: extractedData.expression,
            dependentVariable: extractedData.dependentVariable,
            scope: extractedData.scope,
            ranges: extractedData.ranges
        });

    } catch (error) {
        console.error('Error in /extract-equation:', error.response ? error.response.data : error.message);
        res.json({ success: false, message: 'Error processing the image.' });
    }
});

// API endpoint to solve equations
app.post('/solve', (req, res) => {
    const equation = req.body.equation;
    try {
        const result = math.evaluate(equation);
        res.json({ success: true, result });
    } catch (error) {
        res.json({ success: false, message: 'Invalid equation.' });
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

// Start the server
app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
