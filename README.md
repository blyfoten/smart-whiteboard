# Smart Whiteboard

Smart Whiteboard is an interactive web application that combines the simplicity of a whiteboard with the power of AI to recognize handwritten equations and graph them in real-time.

## 1. Features

- **Digital Whiteboard**: Draw and write freely on a canvas.
- **Equation Recognition**: AI-powered recognition of handwritten mathematical equations.
- **Graphing**: Automatically graph recognized equations.
- **Voice Commands**: Control the whiteboard using voice commands.
- **Multiple AI Models**: Choose between OpenAI GPT and Google Gemini for AI processing.

## 2. Technologies Used

- Frontend: HTML5, CSS3, JavaScript (ES6+)
- Backend: Node.js with Express.js
- AI Integration: OpenAI API and Google Gemini API
- Canvas Manipulation: Fabric.js
- Graphing: Chart.js
- Voice Recognition: Web Speech API

## 3. Getting Started

### 3.1 Prerequisites

- Node.js (v14 or later)
- npm (v6 or later)

### 3.2 Installation

1. Clone the repository:
   ```bash
   git clone https://github.com/blyfoten/smart-whiteboard.git
   cd smart-whiteboard
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Set up environment variables:
   Create a `.env` file in the root directory and add your API keys:
   ```bash
   OPENAI_API_KEY=your_openai_api_key_here
   GEMINI_API_KEY=your_gemini_api_key_here
   ```

4. Build the project:
   ```bash
   npm run build
   ```

5. Start the project:
   ```bash
   npm start
   ```

5. Open your browser and navigate to `http://localhost:3000`

## Usage

1. Use your mouse or touch input to write equations on the whiteboard.
2. Select your preferred AI model (Math.js, GPT, or Gemini) from the dropdown.
3. Click the "Extract Equation" button to recognize the handwritten equation.
4. Use the "Draw Graph" button or voice command to graph the recognized equation.
5. Clear the whiteboard using the "Clear" button or voice command.

## Voice Commands

- "Clear": Clears the whiteboard
- "Solve equation": Extracts the equation from the whiteboard
- "Draw graph": Graphs the extracted equation

## AI Model Selection

The application supports three processing modes:
- **Math.js (Simple)**: Uses the math.js library for basic equation solving. Best for simple calculations.
- **GPT (Advanced)**: Uses OpenAI's GPT model for complex equation recognition and solving.
- **Gemini (Advanced)**: Uses Google's Gemini model for complex equation recognition and solving.

## Getting API Keys

### OpenAI API Key
1. Go to [OpenAI API](https://platform.openai.com/signup)
2. Create an account or sign in
3. Navigate to the API section
4. Generate an API key

### Google Gemini API Key
1. Go to [Google AI Studio](https://makersuite.google.com/app/apikey)
2. Create an account or sign in with your Google account
3. Create a new API key

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## Acknowledgments

- OpenAI for providing GPT capabilities
- Google for providing Gemini capabilities
- The Fabric.js and Chart.js teams for their excellent libraries
