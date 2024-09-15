// app.js

// Initialisera Fabric.js canvas
const canvas = new fabric.Canvas('whiteboard');

// Aktivera ritläge
canvas.isDrawingMode = true;
canvas.freeDrawingBrush.color = "black";
canvas.freeDrawingBrush.width = 5;

// Röstigenkänning
let recognition;
let recognizing = false;
const status = document.getElementById('status');

// Kontrollera om Web Speech API stöds
if ('webkitSpeechRecognition' in window || 'SpeechRecognition' in window) {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    recognition = new SpeechRecognition();
    recognition.lang = 'sv-SE'; // Svenska
    recognition.continuous = false;
    recognition.interimResults = false;

    recognition.onstart = function() {
        recognizing = true;
        status.textContent = 'Röstigenkänning startad. Tala nu.';
    };

    recognition.onresult = function(event) {
        const transcript = event.results[0][0].transcript.trim().toLowerCase();
        status.textContent = 'Du sa: "' + transcript + '"';
        handleCommand(transcript);
        recognizing = false;
    };

    recognition.onerror = function(event) {
        status.textContent = 'Fel vid röstigenkänning: ' + event.error;
        recognizing = false;
    };

    recognition.onend = function() {
        recognizing = false;
        status.textContent = 'Röstigenkänning avslutad.';
    };
} else {
    status.textContent = 'Web Speech API stöds inte i denna webbläsare.';
}

// Lägg till eventlistener på knappen
document.getElementById('start-record-btn').addEventListener('click', function() {
    if (recognizing) {
        recognition.stop();
        recognizing = false;
    } else {
        recognition.start();
    }
});

// Hantera röstkommandon
function handleCommand(command) {
    if (command.includes('rensa')) {
        canvas.clear();
        // Återställ ritläge efter rensning
        canvas.isDrawingMode = true;
    } else if (command.includes('lös ekvationen')) {
        solveEquation();
    } else if (command.includes('rita grafen')) {
        drawGraph();
    } else {
        alert('Kommando ej igenkänt.');
    }
}

// Funktion för att lösa ekvation
function solveEquation() {
    // Extrahera text från canvas
    const objects = canvas.getObjects('text');
    if (objects.length === 0) {
        alert('Ingen ekvation hittades att lösa.');
        return;
    }
    const equation = objects[0].text;
    fetch('/solve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ equation })
    })
    .then(response => response.json())
    .then(data => {
        if (data.success) {
            // Visa resultatet på canvas
            const text = new fabric.Text(`Resultat: ${data.result}`, {
                left: 10,
                top: 50,
                fill: 'blue',
                fontSize: 20
            });
            canvas.add(text);
        } else {
            alert(data.message);
        }
    })
    .catch(error => {
        console.error('Error:', error);
    });
}

// Funktion för att rita graf
function drawGraph() {
    // Extrahera text från canvas
    const objects = canvas.getObjects('text');
    if (objects.length === 0) {
        alert('Ingen ekvation hittades att rita.');
        return;
    }
    const equation = objects[0].text;
    fetch('/graph', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ equation })
    })
    .then(response => response.json())
    .then(data => {
        if (data.success) {
            renderGraph(data.data);
        } else {
            alert(data.message);
        }
    })
    .catch(error => {
        console.error('Error:', error);
    });
}

// Funktion för att rendera graf med Chart.js
function renderGraph(dataPoints) {
    const ctx = document.getElementById('graph-canvas').getContext('2d');
    // Rensa tidigare grafer
    if (window.graphChart) {
        window.graphChart.destroy();
    }

    const labels = dataPoints.map(point => point.x.toFixed(2));
    const data = dataPoints.map(point => point.y);

    window.graphChart = new Chart(ctx, {
        type: 'line',
        data: {
            labels: labels,
            datasets: [{
                label: 'Graf',
                data: data,
                borderColor: 'rgba(75, 192, 192, 1)',
                borderWidth: 2,
                fill: false,
                pointRadius: 0
            }]
        },
        options: {
            scales: {
                x: {
                    type: 'linear',
                    position: 'bottom'
                }
            }
        }
    });
}

// Extra funktionalitet: Lägg till textobjekt på canvas genom dubbelklick
canvas.on('mouse:dblclick', function(options) {
    const pointer = canvas.getPointer(options.e);
    const text = new fabric.IText('Skriv ekvation här', {
        left: pointer.x,
        top: pointer.y,
        fill: 'red',
        fontSize: 20
    });
    canvas.add(text);
    canvas.setActiveObject(text);
});
