import { useState, useRef, useEffect } from 'react';
import { Phone, PhoneOff, Mic, MicOff, Volume2, VolumeX, Video, VideoOff } from 'lucide-react';

type CallStatus = 'idle' | 'calling' | 'ringing' | 'connected';

export function VoipClient() {
  const [callStatus, setCallStatus] = useState<CallStatus>('idle');
  const [isMuted, setIsMuted] = useState(false);
  const [isSpeakerOn, setIsSpeakerOn] = useState(true);
  const [isVideoOn, setIsVideoOn] = useState(false);
  const [phoneNumber, setPhoneNumber] = useState('');
  const [callDuration, setCallDuration] = useState(0);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const callTimerRef = useRef<NodeJS.Timeout | null>(null);

  // Timer for call duration
  useEffect(() => {
    if (callStatus === 'connected') {
      callTimerRef.current = setInterval(() => {
        setCallDuration(prev => prev + 1);
      }, 1000);
    } else {
      if (callTimerRef.current) {
        clearInterval(callTimerRef.current);
      }
      setCallDuration(0);
    }

    return () => {
      if (callTimerRef.current) {
        clearInterval(callTimerRef.current);
      }
    };
  }, [callStatus]);

  // Format call duration
  const formatDuration = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  // Start call
  const handleCall = async () => {
    if (!phoneNumber) return;

    try {
      // Get user media
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: isVideoOn
      });

      setLocalStream(stream);

      if (localVideoRef.current && isVideoOn) {
        localVideoRef.current.srcObject = stream;
      }

      setCallStatus('calling');

      // Simulate call connection after 2 seconds
      setTimeout(() => {
        setCallStatus('connected');
      }, 2000);

    } catch (error) {
      console.error('Error accessing media devices:', error);
      alert('Kunne ikke få adgang til mikrofon/kamera');
    }
  };

  // End call
  const handleEndCall = () => {
    if (localStream) {
      localStream.getTracks().forEach(track => track.stop());
      setLocalStream(null);
    }

    if (localVideoRef.current) {
      localVideoRef.current.srcObject = null;
    }

    setCallStatus('idle');
    setPhoneNumber('');
    setIsMuted(false);
    setIsVideoOn(false);
  };

  // Toggle mute
  const toggleMute = () => {
    if (localStream) {
      localStream.getAudioTracks().forEach(track => {
        track.enabled = !track.enabled;
      });
      setIsMuted(!isMuted);
    }
  };

  // Toggle video
  const toggleVideo = async () => {
    if (callStatus === 'idle') {
      setIsVideoOn(!isVideoOn);
      return;
    }

    if (localStream) {
      if (!isVideoOn) {
        // Turn video on
        try {
          const videoStream = await navigator.mediaDevices.getUserMedia({ video: true });
          const videoTrack = videoStream.getVideoTracks()[0];
          localStream.addTrack(videoTrack);
          
          if (localVideoRef.current) {
            localVideoRef.current.srcObject = localStream;
          }
          setIsVideoOn(true);
        } catch (error) {
          console.error('Error enabling video:', error);
        }
      } else {
        // Turn video off
        localStream.getVideoTracks().forEach(track => {
          track.stop();
          localStream.removeTrack(track);
        });
        setIsVideoOn(false);
      }
    }
  };

  // Handle number pad input
  const handleNumberPad = (digit: string) => {
    if (callStatus === 'idle') {
      setPhoneNumber(prev => prev + digit);
    }
  };

  // Clear number
  const handleClear = () => {
    setPhoneNumber('');
  };

  return (
    <div className="w-full max-w-md bg-white rounded-2xl shadow-2xl overflow-hidden">
      {/* Header */}
      <div className="bg-gradient-to-r from-blue-600 to-indigo-600 text-white p-6">
        <h1 className="text-2xl font-bold mb-2">VOIP Klient</h1>
        <p className="text-blue-100 text-sm">
          {callStatus === 'idle' && 'Indtast nummer'}
          {callStatus === 'calling' && 'Ringer op...'}
          {callStatus === 'ringing' && 'Indkommende opkald'}
          {callStatus === 'connected' && `Forbundet - ${formatDuration(callDuration)}`}
        </p>
      </div>

      {/* Video display */}
      {isVideoOn && callStatus !== 'idle' && (
        <div className="relative bg-gray-900 aspect-video">
          <video
            ref={remoteVideoRef}
            autoPlay
            playsInline
            className="w-full h-full object-cover"
          />
          <div className="absolute bottom-4 right-4 w-24 h-32 bg-gray-800 rounded-lg overflow-hidden border-2 border-white">
            <video
              ref={localVideoRef}
              autoPlay
              playsInline
              muted
              className="w-full h-full object-cover"
            />
          </div>
        </div>
      )}

      {/* Phone number display */}
      <div className="p-6">
        <div className="bg-gray-50 rounded-lg p-4 mb-6 min-h-16 flex items-center justify-center">
          <input
            type="text"
            value={phoneNumber}
            onChange={(e) => setPhoneNumber(e.target.value)}
            placeholder="Indtast telefonnummer"
            className="text-2xl text-center w-full bg-transparent outline-none"
            disabled={callStatus !== 'idle'}
          />
        </div>

        {/* Number pad (only show when idle) */}
        {callStatus === 'idle' && (
          <div className="grid grid-cols-3 gap-3 mb-6">
            {['1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '0', '#'].map((digit) => (
              <button
                key={digit}
                onClick={() => handleNumberPad(digit)}
                className="bg-gray-100 hover:bg-gray-200 active:bg-gray-300 rounded-lg p-4 text-xl font-semibold transition-colors"
              >
                {digit}
              </button>
            ))}
          </div>
        )}

        {/* Call controls */}
        <div className="flex items-center justify-center gap-4 mb-4">
          {callStatus === 'idle' ? (
            <>
              <button
                onClick={toggleVideo}
                className={`p-4 rounded-full transition-all ${
                  isVideoOn
                    ? 'bg-blue-600 text-white hover:bg-blue-700'
                    : 'bg-gray-200 text-gray-700 hover:bg-gray-300'
                }`}
              >
                {isVideoOn ? <Video size={24} /> : <VideoOff size={24} />}
              </button>
              
              <button
                onClick={handleCall}
                disabled={!phoneNumber}
                className="bg-green-500 hover:bg-green-600 active:bg-green-700 disabled:bg-gray-300 disabled:cursor-not-allowed text-white rounded-full p-6 transition-all transform hover:scale-105"
              >
                <Phone size={32} />
              </button>

              <button
                onClick={handleClear}
                className="bg-gray-200 hover:bg-gray-300 active:bg-gray-400 text-gray-700 rounded-full p-4 transition-all"
              >
                <span className="text-xl font-bold">C</span>
              </button>
            </>
          ) : (
            <>
              <button
                onClick={toggleMute}
                className={`p-4 rounded-full transition-all ${
                  isMuted
                    ? 'bg-red-500 text-white hover:bg-red-600'
                    : 'bg-gray-200 text-gray-700 hover:bg-gray-300'
                }`}
              >
                {isMuted ? <MicOff size={24} /> : <Mic size={24} />}
              </button>

              <button
                onClick={toggleVideo}
                className={`p-4 rounded-full transition-all ${
                  isVideoOn
                    ? 'bg-blue-600 text-white hover:bg-blue-700'
                    : 'bg-gray-200 text-gray-700 hover:bg-gray-300'
                }`}
              >
                {isVideoOn ? <Video size={24} /> : <VideoOff size={24} />}
              </button>

              <button
                onClick={handleEndCall}
                className="bg-red-500 hover:bg-red-600 active:bg-red-700 text-white rounded-full p-6 transition-all transform hover:scale-105"
              >
                <PhoneOff size={32} />
              </button>

              <button
                onClick={() => setIsSpeakerOn(!isSpeakerOn)}
                className={`p-4 rounded-full transition-all ${
                  isSpeakerOn
                    ? 'bg-blue-600 text-white hover:bg-blue-700'
                    : 'bg-gray-200 text-gray-700 hover:bg-gray-300'
                }`}
              >
                {isSpeakerOn ? <Volume2 size={24} /> : <VolumeX size={24} />}
              </button>
            </>
          )}
        </div>

        {/* Status indicator */}
        {callStatus !== 'idle' && (
          <div className="text-center">
            <div className="inline-flex items-center gap-2 bg-green-100 text-green-700 px-4 py-2 rounded-full">
              <div className="w-2 h-2 bg-green-500 rounded-full animate-pulse"></div>
              <span className="text-sm font-medium">
                {callStatus === 'calling' && 'Forbinder...'}
                {callStatus === 'connected' && 'Aktiv samtale'}
              </span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
