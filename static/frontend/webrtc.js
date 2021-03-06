import { VideoGridLayout } from "./video-grid-layout.js";
import { CONFIG } from "./config.js";

const signalServerConnectionStatus = document.getElementById("signalServerConnection");
const userSelect = document.getElementById("userSelect");
const connectToSignalServerButton = document.getElementById("connectToSignalServer");

const callButton = document.getElementById("call");
const hangupButton = document.getElementById("hangup");

const localVideo = document.getElementById("localVideo");
const remoteContainer = document.getElementById("remoteContainer");
const remoteContainerParent = remoteContainer.parentNode;

const videoGridLayout = new VideoGridLayout(remoteContainer);
videoGridLayout.render();

const mediaButton = document.getElementById("media");
const previewButton = document.getElementById("preview");
const videoButton = document.getElementById("video");
const audioButton = document.getElementById("audio");

const NO_DISPLAY_CLASS = "no-display";

const ON = "ON";
const OFF = "OFF";

const OFFER = "offer";
const ANSWER = "answer";
const CANDIDATE = "candidate";

const USER_AUTHENTICATION = "USER_AUTHENTICATION";
const USER_AUTHENTICATED = "USER_AUTHENTICATED";
const JOIN_ROOM = "JOIN_ROOM";
const LEAVE_ROOM = "LEAVE_ROOM";
const ROOM_MEMBERS = "ROOM_MEMBERS";
const PEER_LOG = "PEER_LOG";
const PING = "PING";
const PONG = "PONG";
const SERVER_CLOSING = "SERVER_CLOSING";

const PING_FREQUENCY = 2500;
const PONG_FREQUENCY = 10000;
let lastPong = 0;
let pongInterval = null;

const ICE_CONNECTED = "connected";
const ICE_DISCONNECTED = "disconnected";
const ICE_FAILED = "failed";

const RECONNECT_TIMEOUT = 4000;

const highQualityVideoConstraints = {
    width: { ideal: 640, max: 960 },
    height: { ideal: 480, max: 720 },
    frameRate: 25
};

const mediumQualityVideoConstraints = {
    width: { ideal: 320, max: 480 },
    height: { ideal: 240, max: 360 },
    frameRate: 20
};

const lowQualityVideoConstraints = {
    width: { ideal: 160, max: 200 },
    height: { ideal: 120, max: 200 },
    frameRate: 20
};

const streamConstraints = {
    video: highQualityVideoConstraints,
    audio: true
};

const peerConnections = new Map();

let user;
let authenticated = false;
let signalServerSocket;
let localStream;
let inCall = false;
let initiateOffer = true;

callButton.disabled = true;
hangupButton.disabled = true;

connectToSignalServerButton.onclick = connectToSignalServer;

mediaButton.onclick = startVideoStream;
previewButton.onclick = togglePreview;
videoButton.onclick = toggleVideoStream;
audioButton.onclick = toggleAudioStream;
callButton.onclick = call;
hangupButton.onclick = hangup;

localVideo.onloadedmetadata = () => console.log(`Local video videoWidth: ${localVideo.videoWidth}px,  videoHeight: ${localVideo.videoHeight}px`);
localVideo.onresize = () => console.log(`Local video size changed to ${localVideo.videoWidth}x${localVideo.videoHeight}`);


function connectToSignalServer() {
    function isServerMessage(message) {
        return message.type;
    }

    const userSecret = userSelect.value;
    if (!userSelect) {
        alert("User need to be selected");
        return;
    }

    if (signalServerSocket) {
        signalServerSocket.close();
        onCloseSignalServerSocket();
        return;
    }

    user = parseInt(userSelect[userSelect.selectedIndex].text);
    console.log("Connecting as user = " + user);

    signalServerSocket = new WebSocket(CONFIG.signalServerEndpoint);

    signalServerSocket.onopen = () => {
        sendToSignalServer({
            type: USER_AUTHENTICATION,
            data: userSecret
        });
        alert("SignalServerConnection established, sending credentials");
    };

    signalServerSocket.onmessage = e => {
        try {
            const message = JSON.parse(e.data);
            if (isServerMessage(message)) {
                handleServerMessage(message);
            } else {
                handleEvent(message.from, message.event, message.data);
            }
        } catch (e) {
            userLog("Problem while handling message from SignalServer...", e.data);
        }
    };

    signalServerSocket.onerror = e => alert(`SignalServerConnection error: ${JSON.stringify(e)}`);

    signalServerSocket.onclose = onCloseSignalServerSocket;
}

function onCloseSignalServerSocket(e) {
    if (signalServerSocket == null) {
        return;
    }
    signalServerSocket = null;
    authenticated = false;
    lastPong = 0;
    updateSignalServerConnectionStatus(OFF);
    hangup();

    if (pongInterval) {
        clearInterval(pongInterval);
        pongInterval = null;
    }

    if (e) {
        if (e.wasClean) {
            alert(`Connection closed cleanly, code=${e.code}, reason=${e.reason}`);
        } else {
            alert(`Connection died, code=${e.code}`);
        }
    }
}

function setupPingPong() {
    lastPong = Date.now();

    const ping = { type: PING };
    sendToSignalServer(ping);

    pongInterval = setInterval(() => {
        if (!signalServerSocket) {
            return;
        }

        if (signalServerSocket.readyState == WebSocket.OPEN) {
            sendToSignalServer(ping);
        }

        const inactive = (Date.now() - lastPong) > PONG_FREQUENCY;
        if (inactive) {
            console.log("Inactive server connection, closing");
            signalServerSocket.close();
            onCloseSignalServerSocket();
        }
    }, PING_FREQUENCY);
}

function handleServerMessage(message) {
    if (message.type == PONG) {
        lastPong = Date.now();
        return;
    }

    userLog('Message received from server...', message);
    if (message.type == USER_AUTHENTICATED) {
        console.log("SignalServerConnection is authenticated");
        authenticated = true;
        updateSignalServerConnectionStatus(ON);
        if (lastPong == 0) {
            setupPingPong();
        }
    } else if (message.type == ROOM_MEMBERS) {
        setupPeerConnections(message.data);
    } else if (message.type == SERVER_CLOSING) {
        console.log("Server is closing...");
    } else {
        console.log("Unknown message type from server, ignoring it");
    }
}

function sendToSignalServer(data) {
    signalServerSocket.send(JSON.stringify(data));
}

function sendEventToSignalServer(to, event, data) {
    sendToSignalServer({
        from: user,
        to: to,
        event: event,
        data: data
    });
}

function updateSignalServerConnectionStatus(status) {
    signalServerConnectionStatus.textContent = status;
}

function handleEvent(from, event, data) {
    if (noPeerConnections()) {
        console.log(`Peers not connected, skipping event ${event} from ${from} peer`);
        return;
    }

    if (!peerConnections.has(from)) {
        console.log(`No peer connection of ${from} id, skipping`);
        console.log("All connections..." + peerConnections.keys());
        return;
    }

    console.log(`Handling event from ${from} peer`)

    if (event == OFFER) {
        handleOffer(from, data);
    } else if (event == ANSWER) {
        handleAnswer(from, data);
    } else if (event == CANDIDATE) {
        handleCandidate(from, data);
    } else {
        console.log(`Unknown event (${event}), ignoring it`, data);
    }
}

function noPeerConnections() {
    return peerConnections.size == 0;
}

function updateVideoStreamQuality() {
    if (localStream == null || true) {
        console.log("Local stream is not set, skipping quality change");
        return;
    }
    //FIX it: not working on chrome, firefox not supporting constraints (?) almost at all
    let newConstraints;
    if (peerConnections.size <= 2) {
        console.log("Up to 2 peers, using high quality video");
        newConstraints = highQualityVideoConstraints;
    } else {
        console.log("More than 2 peers, switching to medium quality");
        newConstraints = mediumQualityVideoConstraints;
    }

    streamConstraints.video = newConstraints;

    localStream.getVideoTracks().forEach(t => {
        console.log("Applying new constraints to stream...", newConstraints);
        t.applyConstraints(streamConstraints)
            .then(() => console.log("Constraints applied"))
            .catch(e => console.log("Fail to apply new constraints", e));
    });
}

async function handleOffer(from, offer) {
    const peerConnection = peerConnections.get(from);
    try {
        peerLog(from, "Handling offer...");
        await peerConnection.setRemoteDescription(new RTCSessionDescription(offer));
    } catch (e) {
        peerLog(from, `Failed to create SDP from remote offer: ${e}`);
    }

    try {
        peerLog(from, "Creating answer...");
        const answer = await peerConnection.createAnswer();
        onCreateAnswerSuccess(peerConnection, from, answer);
    } catch (e) {
        peerLog(from, `Failed to create answer to offer: ${e}`);
    }
}

async function onCreateAnswerSuccess(peerConnection, to, answer) {
    peerLog(to, "Answer created");
    peerLog(to, "Setting is as local description");
    try {
        await peerConnection.setLocalDescription(answer);
        peerLog(to, "Local description from answer created, sending to remote");
        sendEventToSignalServer(to, ANSWER, answer);
    } catch (e) {
        peerLog(to, `Failed to set local session description: ${e}`);
    }
}

async function handleAnswer(from, answer) {
    try {
        const peerConnection = peerConnections.get(from);
        await peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
    } catch (e) {
        peerLog(from, "Problem while handling answer: " + e);
    }
}

async function handleCandidate(from, candidate) {
    try {
        const peerConnection = peerConnections.get(from);
        await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (e) {
        peerLog(from, "Problem while handling candidate: " + e);
    }

}

async function startVideoStream() {
    if (localStream) {
        console.log("Stopping local stream...")
        stopVideoStream();
        return;
    }
    console.log("Requesting local stream");
    mediaButton.disabled = true;
    try {
        const stream = await navigator.mediaDevices.getUserMedia(streamConstraints);
        console.log("Received local stream");
        localVideo.srcObject = stream;
        localStream = stream;
        callButton.disabled = false;
    } catch (e) {
        alert(`getUserMedia() error: ${e}`);
    }
    mediaButton.disabled = false;
    videoButton.disabled = false;
    audioButton.disabled = false;
}

function stopVideoStream() {
    localStream.getTracks().forEach(t => t.stop());

    callButton.disabled = true;
    videoButton.disabled = true;
    audioButton.disabled = true;

    setVideoStateButton(true);
    setAudioStateButton(true);

    localStream = null;
}

function togglePreview() {
    localVideo.classList.toggle("hidden");
}

function toggleVideoStream() {
    if (!localStream) {
        return;
    }
    localStream.getVideoTracks().forEach(t => {
        const newState = !t.enabled;
        console.log("Setting video track to enabled = " + newState);
        t.enabled = newState;
        setVideoStateButton(newState);
    });
}

function setVideoStateButton(state) {
    videoButton.textContent = "Video: " + (state ? ON : OFF);
}

function toggleAudioStream() {
    if (!localStream) {
        return;
    }
    localStream.getAudioTracks().forEach(t => {
        const newState = !t.enabled;
        console.log("Setting audio track to enabled = " + newState);
        t.enabled = newState;
        setAudioStateButton(newState);
    });
}

function setAudioStateButton(state) {
    audioButton.textContent = "Audio: " + (state ? ON : OFF);
}

async function call() {
    if (!user) {
        alert("User need to be selected");
        return;
    }
    if (!authenticated) {
        alert("You need to establish connection with SignalServer first");
        return;
    }
    callButton.disabled = true;
    hangupButton.disabled = false;

    console.log("Staring call, sending signal to SignalServer....");

    const videoTracks = localStream.getVideoTracks();
    const audioTracks = localStream.getAudioTracks();

    if (videoTracks.length > 0) {
        userLog(`Using video device: ${videoTracks[0].label}, with settings: `, videoTracks[0].getSettings());
        showAvailableDevices("videoinput");
    }
    if (audioTracks.length > 0) {
        userLog(`Using audio device: ${audioTracks[0].label}, with settings: `, audioTracks[0].getSettings());
    }

    inCall = true;
    sendToSignalServer({ type: JOIN_ROOM });
    remoteContainerParent.classList.remove(NO_DISPLAY_CLASS);
}

async function showAvailableDevices(kind) {
    try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        devices.forEach(d => {
            if (d.kind == kind) {
                userLog(`Available ${kind} device: `, {
                    label: d.label,
                    deviceId: d.deviceId,
                    kind: d.kind,
                    capabilities: (typeof d.getCapabilities == 'function') ? d.getCapabilities() : {}
                });
            }
        })
    } catch (e) {
        userLog("Problem while gathering available devices: " + e);
    }
}

function setupPeerConnections(peers) {
    if (!inCall) {
        console.log("Not in call, skipping peers setup")
        return;
    }

    if (initiateOffer) {
        console.log("RTCPeerConnection configuration: ", CONFIG.webrtcConfiguration);
        console.log("Peers to connect: ", peers);
    }

    try {
        for (const pid of peers) {
            if (pid == user) {
                peerLog(pid, "Skipping user peer");
            } else {
                if (peerConnections.has(pid)) {
                    console.log(`Connection to ${pid} exists, skipping`);
                    continue;
                }
                const peerConnection = newPeerConnection(pid, initiateOffer);
                if (initiateOffer) {
                    createOffer(pid, peerConnection);
                }
            }
        }

        closeInactiveConnections(peers);
    } finally {
        initiateOffer = false;
        videoGridLayout.refresh();
        setupRemoteVideosListeners();
        updateVideoStreamQuality();
    }
}

function closeInactiveConnections(peers) {
    const toClose = [];

    for (const pid of peerConnections.keys()) {
        if (!peers.includes(pid)) {
            toClose.push(pid);
        }
    }

    toClose.forEach(pid => {
        peerLog(pid, 'Closing inactive peer');
        closePeer(pid, peerConnections.get(pid));
        peerConnections.delete(pid);
    });
}

function closePeer(peerId, peerConnection) {
    peerConnection.close();
    removePeerVideo(peerId);
}

function newPeerConnection(peerId, offerer) {
    const peerConnection = new RTCPeerConnection(CONFIG.webrtcConfiguration);

    setupPeerConnection(peerId, peerConnection, offerer);

    peerLog(peerId, "Created local peer connection as offerer: " + offerer);
    peerConnections.set(peerId, peerConnection);

    peerLog(peerId, "Adding streams to peer connection");
    localStream.getTracks().forEach(t => peerConnection.addTrack(t, localStream));
    peerLog(peerId, "Added local stream to peer connection");

    return peerConnection;
}

function setupPeerConnection(peerId, peerConnection, offerer) {
    let handlingIceProblem = false;

    function handleIceProblem(pid, state) {
        if (handlingIceProblem) {
            peerLog(pid, `ICE ${state} is being handled, returning`);
            return;
        }

        handlingIceProblem = true;
        setTimeout(() => {
            peerLog(pid, `Handling: ${state}`);
            handlingIceProblem = false;
            const pc = peerConnections.get(pid);
            if (!pc) {
                peerLog(pid, "Peer is no longer active skipping reconnect");
                return;
            }
            if (pc.iceConnectionState != state) {
                peerLog(pid, `Connection is no longer ${state}, but ${pc.iceConnectionState}, skipping`);
                return;
            }
            peerLog(pid, `Can't get back to connected in ${RECONNECT_TIMEOUT} ms, recreating connection`);
            recreatePeerConnection(peerId, true);
        }, RECONNECT_TIMEOUT);
    }

    peerConnection.onicecandidate = e => {
        try {
            const candidate = e.candidate;
            if (candidate) {
                peerLog(peerId, 'Send ICE candidate:\n', e.candidate);
                sendEventToSignalServer(peerId, CANDIDATE, candidate);
            } else {
                peerLog(peerId, "Skipping null ICE candidate");
            }
        } catch (e) {
            peerLog(peerId, `Failed to send ICE Candidate: ${e}`);
        }
    };

    peerConnection.onicecandidateerror = e => peerLog(peerId, "ICE candidate error", e);

    peerConnection.onicegatheringstatechange = () => peerLog(peerId, `ICE gathering state change: ${peerConnection.iceGatheringState}`);

    peerConnection.onsignalingstatechange = () => peerLog(peerId, `ICE signalling state change: ${peerConnection.signalingState}`);

    peerConnection.oniceconnectionstatechange = () => {
        peerLog(peerId, `ICE state change event: ${peerConnection.iceConnectionState}`);
        updatePeerStateDescription(peerId, peerConnection.iceConnectionState, offerer);

        if (peerConnection.iceConnectionState == ICE_DISCONNECTED) {
            if (offerer) {
                handleIceProblem(peerId, ICE_DISCONNECTED);
            } else {
                peerLog(peerId, `Not offerer, ${ICE_DISCONNECTED} will be handled by second peer`);
            }
        } else if (peerConnection.iceConnectionState == ICE_FAILED) {
            if (offerer) {
                handleIceProblem(peerId, ICE_FAILED);
            } else {
                peerLog(peerId, `Not offerer, ${ICE_FAILED} will be handled by second peer`);
            }
        } else if (peerConnection.iceConnectionState == ICE_CONNECTED) {
            peerLog(peerId, `Peer ${ICE_CONNECTED}, trying to find connected candidates...`);
            logConnectionStats(peerId, peerConnection);
        }
    };

    const peerVideo = createPeerVideo(peerId);
    peerConnection.ontrack = e => {
        if (!peerVideo.srcObject) {
            peerLog(peerId, "No remote stream set up, taking first one", e.streams);
            peerVideo.srcObject = e.streams[0];
        } else {
            peerLog(peerId, "Peer received same remote stream again, skipping");
        }
    };
}

async function logConnectionStats(peerId, peerConnection, retries = 3) {
    try {
        const stats = await peerConnection.getStats();

        const candidatePair = selectedCandidatePair(stats);
        if (!candidatePair) {
            peerLog(peerId, "Can't find selected and nominated candidatePair...");
            if (retries > 0) {
                peerLog(peerId, `Retries left: ${retries}...`);
                setTimeout(async () => logConnectionStats(peerId, peerConnection, retries - 1), 1000);
            }
            return;
        }

        peerLog(peerId, "Nominated and suceeded candidatePair: ", candidatePair);

        const candidates = selectedCandidates(candidatePair, stats);
        peerLog(peerId, "Selected and nominated candidates: ", candidates);
    } catch (e) {
        peerLog(peerId, "Failed to gather connection stats", e);
    }
}

function selectedCandidatePair(stats) {
    for (const v of stats.values()) {
        if (v.type == "candidate-pair" && v.nominated && v.state == "succeeded") {
            return v;
        }
    }
    return null;
}

function selectedCandidates(candidatePair, stats) {
    const localCandidateId = candidatePair.localCandidateId;
    const remoteCandidateId = candidatePair.remoteCandidateId;

    let localCandidate = null;
    let remoteCandidate = null;
    for (const v of stats.values()) {
        if (v.type == "local-candidate" && v.id == localCandidateId) {
            localCandidate = v;
        } else if (v.type == "remote-candidate" && v.id == remoteCandidateId) {
            remoteCandidate = v;
        }

        if (localCandidate && remoteCandidate) {
            break;
        }
    }

    return {
        local: localCandidate,
        remote: remoteCandidate
    };
}

function recreatePeerConnection(peerId, offer = true) {
    const pc = peerConnections.get(peerId);

    closePeer(peerId, pc);

    const newPc = newPeerConnection(peerId, offer);
    if (offer) {
        createOffer(peerId, newPc);
    }

    videoGridLayout.refresh();
    setupRemoteVideosListeners();
}

function peerLog(peerId, message, ...objects) {
    const formatted = `${new Date().toISOString()}, Peer: ${peerId} - ${message}`;
    console.log(formatted, ...objects);

    let jsonObjects;
    if (objects.length > 0) {
        jsonObjects = objects.map(o => JSON.stringify(o, null, 2));
    } else {
        jsonObjects = [];
    }

    if (signalServerSocket) {
        sendToSignalServer({
            type: PEER_LOG,
            data: {
                peerId: peerId,
                message: formatted,
                objects: jsonObjects
            }
        });
    }
}

function userLog(message, ...objects) {
    peerLog(user, message, objects);
}

function createPeerVideo(peerId) {
    const container = document.createElement("div");
    container.className = "remote-video-container";

    const video = document.createElement("video");
    video.autoplay = true;

    const peerDescription = document.createElement("div");
    peerDescription.id = peerDescriptionId(peerId);
    peerDescription.textContent = `${peerId}: CONNECTING`;

    container.id = peerVideoId(peerId);
    container.appendChild(video);
    container.appendChild(peerDescription);

    remoteContainer.appendChild(container);

    return video;
}

function peerDescriptionId(peerId) {
    return `remoteDescription_${peerId}`;
}

function updatePeerStateDescription(peerId, state, offerer = false) {
    const peerDescription = document.getElementById(peerDescriptionId(peerId));
    if (peerDescription) {
        let stateDescription = state.toUpperCase();
        if (state == ICE_DISCONNECTED || state == ICE_FAILED) {
            const suffix = offerer ? "handling..." : "handled by peer";
            stateDescription = `${stateDescription} - ${suffix}`;
        }
        peerDescription.textContent = `${peerId}: ${stateDescription}`;
    }
}

function peerVideoId(peerId) {
    return `remoteVideo_${peerId}`;
}

function peerIdFromVideo(video) {
    const prefixId = video.parentNode.id.split("_");
    return prefixId[1];
}

function removePeerVideo(peerId) {
    const videoContainer = document.getElementById(peerVideoId(peerId));
    if (videoContainer) {
        videoContainer.remove();
    }
}

async function createOffer(peerId, peerConnection) {
    try {
        peerLog(peerId, "Starting to create an offer");
        const offer = await peerConnection.createOffer();
        await onCreateOfferSuccess(peerId, peerConnection, offer);
    } catch (e) {
        peerLog(peerId, `Failed to create SDP: ${e}`);
    }
}

async function onCreateOfferSuccess(peerId, peerConnection, offer) {
    peerLog(peerId, "Offer created");
    peerLog(peerId, "Setting it as local description");
    try {
        await peerConnection.setLocalDescription(offer);
        peerLog(peerId, "Offer created, sending it to peer");
        sendEventToSignalServer(peerId, OFFER, offer);
    } catch (e) {
        peerLog(peerId, `Failed to set local session description: ${e}`);
    }
}

function hangup() {
    console.log("Ending call");

    inCall = false;

    for (const [id, pc] of peerConnections.entries()) {
        console.log(`Closing ${id} peer connection`);
        closePeer(id, pc);
    }

    peerConnections.clear();
    initiateOffer = true;

    if (signalServerSocket) {
        console.log("Sending message to SignalServer");
        sendToSignalServer({ type: LEAVE_ROOM });
    }

    hangupButton.disabled = true;
    callButton.disabled = false;

    videoGridLayout.refresh();
    remoteContainerParent.classList.add(NO_DISPLAY_CLASS);
}

function setupRemoteVideosListeners() {
    for (const rv of remoteContainer.querySelectorAll("video")) {
        const peerId = peerIdFromVideo(rv);
        rv.onloadedmetadata = () => peerLog(peerId, `Remote video videoWidth: ${rv.videoWidth}px,  videoHeight: ${rv.videoHeight}px`);
        rv.onresize = () => {
            peerLog(peerId, `Remote video size changed to ${rv.videoWidth}x${rv.videoHeight}`);
            //shouldn't we do something more now ?
        };
    }
}