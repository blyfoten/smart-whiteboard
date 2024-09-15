# Smart Whiteboard

Smart Whiteboard is an interactive web application that combines the simplicity of a whiteboard with the power of AI to recognize handwritten equations and graph them in real-time.

## 1. Features

- **Digital Whiteboard**: Draw and write freely on a canvas.
- **Equation Recognition**: AI-powered recognition of handwritten mathematical equations.
- **Graphing**: Automatically graph recognized equations.
- **Voice Commands**: Control the whiteboard using voice commands.

## 2. Technologies Used

- Frontend: HTML5, CSS3, JavaScript (ES6+)
- Backend: Node.js with Express.js
- AI Integration: OpenAI API
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
   Create a `.env` file in the root directory and add your OpenAI API key:
   ```bash
   OPENAI_API_KEY=your_api_key_here
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
2. Click the "Extract Equation" button to recognize the handwritten equation.
3. Use the "Draw Graph" button or voice command to graph the recognized equation.
4. Clear the whiteboard using the "Clear" button or voice command.

## Voice Commands

- "Clear": Clears the whiteboard
- "Solve equation": Extracts the equation from the whiteboard
- "Draw graph": Graphs the extracted equation

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## Acknowledgments

- OpenAI for providing the AI capabilities
- The Fabric.js and Chart.js teams for their excellent libraries
