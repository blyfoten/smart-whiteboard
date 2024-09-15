## Getting Started

### Prerequisites

- Node.js (v14 or later)
- npm (v6 or later)

### Installation

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
   This command uses webpack to bundle your JavaScript files and their dependencies.

5. Start the server:
   ```bash
   npm start
   ```

6. Open your browser and navigate to `http://localhost:3000`

### Development

If you're actively developing and want to rebuild automatically on file changes, you can use:

```
npm run watch
```

This will start webpack in watch mode, automatically rebuilding when you make changes to your source files.
