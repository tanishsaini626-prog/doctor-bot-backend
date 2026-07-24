// 1. Load hidden passwords
require('dotenv').config();
console.log("🔥 FILE UPDATED SUCCESSFULLY! 🔥");

// 2. Import tools
const express = require('express');
const mongoose = require('mongoose');
const app = express();

// 3. Setup translator for Twilio
app.use(express.urlencoded({ extended: false }));

// ==========================================
// 4. CONNECT TO MONGODB DATABASE
// ==========================================
mongoose.connect("mongodb+srv://USERNAME:PASSWORD@cluster0.xxxxx.mongodb.net/doctorBot")
    .then(function() {
        console.log("✅ Connected to MongoDB Database!");
    })
    .catch(function(err) {
        console.log("❌ Database connection error:", err);
    });

// 5. Define what an Appointment looks like in the database
const Appointment = mongoose.model('Appointment', new mongoose.Schema({
    name: String,
    date: String,
    reason: String,
    time_slot: String
}));

// ==========================================
// 6. THE INITIAL GREETING
// ==========================================
app.get('/webhook/doctor-bot', function(request, response) {
    console.log("📞 Incoming call from test_call.py...");

    let replyMessage = '<?xml version="1.0" encoding="UTF-8"?>';
    replyMessage += '<Response>';
    replyMessage += '<Say language="hi-IN">Namaste, main doctor Sharma ka assistant hoon.</Say>';
    replyMessage += '</Response>';

    response.set('Content-Type', 'application/xml');
    response.send(replyMessage);
});

// ==========================================
// 7. WHEN THE USER SPEAKS
// ==========================================
app.post('/webhook/doctor-bot', async function(request, response) {
    
    let userSaid = request.body.SpeechResult;
    let transcript = userSaid.toLowerCase().trim();
    console.log("User said: " + userSaid);

    let extractedName = null;

    if (transcript.includes("mera naam") || transcript.includes("मेरा नाम")) {
        let parts = transcript.split("naam");
        if (parts.length > 1) {
            extractedName = parts[1].replace(/\s*(hai|hoon|है|हूँ)\s*/g, "").trim();
        }
    } else if (transcript.split(/\s+/).length <= 2 && transcript.length > 2) {
        extractedName = transcript;
    }

    if (extractedName) {
        extractedName = extractedName.replace(/^(dr|dr\.|doctor|mr|mr\.|ji|डॉ|डॉक्टर|जी)\s*/i, "").trim();
        extractedName = extractedName.replace(/\s+(ji|जी)$/i, "").trim();
        console.log("✅ Extracted Clean Name: " + extractedName);
        
        console.log("⏳ Trying to save to MongoDB...");
        try {
            const newAppointment = new Appointment({ name: extractedName });
            await newAppointment.save();
            console.log("💾 Saved to database!");
        } catch (error) {
            console.log("❌ Database error:", error.message);
        }
    } else {
        console.log("❌ Could not find a name.");
    }

    let replyMessage = '<?xml version="1.0" encoding="UTF-8"?><Response>';
    if (extractedName) {
        replyMessage += '<Say language="hi-IN">Thank you ' + extractedName + '. Dhanyavaad!</Say>';
    } else {
        replyMessage += '<Say language="hi-IN">Sorry, naam nahi mila. Dhanyavaad!</Say>';
    }
    replyMessage += '<Hangup/></Response>';

    response.set('Content-Type', 'application/xml');
    response.send(replyMessage);
});
// ==========================================
// 8. TURNING THE SERVER ON
// ==========================================
let portNumber = 5000;

app.listen(portNumber, function() {
    console.log("===================================");
    console.log("SUCCESS! Server is running.");
    console.log("I am listening on port: " + portNumber);
    console.log("===================================");
});