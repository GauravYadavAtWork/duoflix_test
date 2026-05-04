import { useEffect, useMemo, useRef, useState } from "react";

const API_BASE = import.meta.env.VITE_API_BASE || "http://localhost:3001";
const REACTION_OPTIONS = ["\u{1F525}", "\u{1F602}", "\u{1F44F}", "\u{1F62E}", "\u{2764}\u{FE0F}"];
const NAV_ITEMS = [
  { href: "/", label: "Home" },
  { href: "/browse", label: "Browse" }
];
const FEATURE_POINTS = [
  "Cinematic browsing for your local library",
  "Real-time rooms with synchronized playback",
  "Live reactions and chat inside theater mode"
];
const LANDING_STATS = [
  { value: "Sync", label: "playback state" },
  { value: "Live", label: "room chat" },
  { value: "Local", label: "movie source" }
];

function PlayIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M8 6.5v11l9-5.5-9-5.5Z" fill="currentColor" />
    </svg>
  );
}

function PauseIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M8 6h3.5v12H8V6Zm4.5 0H16v12h-3.5V6Z" fill="currentColor" />
    </svg>
  );
}

function BackwardIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M11.5 7v10L4 12l7.5-5Zm8 0v10L12 12l7.5-5Z" fill="currentColor" />
    </svg>
  );
}

function ForwardIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12.5 7v10l7.5-5-7.5-5Zm-8 0v10l7.5-5L4.5 7Z" fill="currentColor" />
    </svg>
  );
}

function toWsUrl(httpBase) {
  const url = new URL(httpBase);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/";
  return url.toString();
}

function formatTime(value) {
  if (!Number.isFinite(value)) {
    return "00:00";
  }

  const totalSeconds = Math.floor(value);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return [hours, minutes, seconds].map((part) => String(part).padStart(2, "0")).join(":");
  }

  return [minutes, seconds].map((part) => String(part).padStart(2, "0")).join(":");
}

function parseRoute(pathname, search) {
  const params = new URLSearchParams(search);

  if (pathname === "/") {
    return { page: "home" };
  }

  if (pathname === "/browse") {
    return { page: "browse" };
  }

  if (pathname === "/join") {
    return { page: "join", roomId: params.get("room") || "" };
  }

  if (pathname.startsWith("/movie/")) {
    return { page: "movie", movieId: decodeURIComponent(pathname.slice("/movie/".length)) };
  }

  if (pathname.startsWith("/watch/solo/")) {
    return { page: "solo", movieId: decodeURIComponent(pathname.slice("/watch/solo/".length)) };
  }

  if (pathname === "/watch/party") {
    return { page: "watch-party" };
  }

  return { page: "not-found" };
}

function useRouter() {
  const [locationState, setLocationState] = useState({
    pathname: window.location.pathname,
    search: window.location.search
  });

  useEffect(() => {
    const onPopState = () => {
      setLocationState({
        pathname: window.location.pathname,
        search: window.location.search
      });
    };

    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const navigate = (nextPath) => {
    const currentPath = `${window.location.pathname}${window.location.search}`;

    if (nextPath === currentPath) {
      return;
    }

    window.history.pushState({}, "", nextPath);
    setLocationState({
      pathname: window.location.pathname,
      search: window.location.search
    });
    window.scrollTo({ top: 0, behavior: "instant" });
  };

  return {
    route: parseRoute(locationState.pathname, locationState.search),
    pathname: locationState.pathname,
    navigate
  };
}

function useWatchParty({ enabled, pendingAction }) {
  const socketRef = useRef(null);
  const retryRef = useRef(0);
  const roomIdRef = useRef(null);
  const userNameRef = useRef("");
  const pendingActionRef = useRef(pendingAction);
  const reactionTimersRef = useRef([]);
  const [status, setStatus] = useState(enabled ? "connecting" : "disconnected");
  const [participantCount, setParticipantCount] = useState(1);
  const [messages, setMessages] = useState([]);
  const [roomState, setRoomState] = useState(null);
  const [latestPlayerEvent, setLatestPlayerEvent] = useState(null);
  const [roomError, setRoomError] = useState(null);
  const [reactions, setReactions] = useState([]);

  useEffect(() => {
    pendingActionRef.current = pendingAction;
    userNameRef.current = pendingAction?.userName || userNameRef.current;
  }, [pendingAction]);

  useEffect(() => {
    if (!enabled) {
      roomIdRef.current = null;
      userNameRef.current = "";
      setStatus("disconnected");
      setParticipantCount(1);
      setMessages([]);
      setRoomState(null);
      setLatestPlayerEvent(null);
      setRoomError(null);
      setReactions([]);

      for (const timer of reactionTimersRef.current) {
        window.clearTimeout(timer);
      }

      reactionTimersRef.current = [];

      if (socketRef.current) {
        socketRef.current.close();
        socketRef.current = null;
      }

      return undefined;
    }

    let cancelled = false;
    let retryTimer = null;

    const connect = () => {
      setStatus(roomIdRef.current ? "reconnecting" : "connecting");

      const ws = new WebSocket(toWsUrl(API_BASE));
      socketRef.current = ws;

      ws.addEventListener("open", () => {
        retryRef.current = 0;
        setStatus("connected");
      });

      ws.addEventListener("message", (event) => {
        const message = JSON.parse(event.data);

        if (message.type === "connected") {
          if (roomIdRef.current && userNameRef.current) {
            ws.send(JSON.stringify({
              type: "join_room",
              roomId: roomIdRef.current,
              userName: userNameRef.current
            }));
            return;
          }

          if (pendingActionRef.current?.type === "create") {
            userNameRef.current = pendingActionRef.current.userName;
            ws.send(JSON.stringify({
              type: "create_room",
              movieId: pendingActionRef.current.movieId,
              userName: pendingActionRef.current.userName
            }));
            return;
          }

          if (pendingActionRef.current?.type === "join") {
            userNameRef.current = pendingActionRef.current.userName;
            roomIdRef.current = pendingActionRef.current.roomId;
            ws.send(JSON.stringify({
              type: "join_room",
              roomId: pendingActionRef.current.roomId,
              userName: pendingActionRef.current.userName
            }));
          }
        }

        if (message.type === "room_created" || message.type === "room_joined") {
          roomIdRef.current = message.roomId;
          setRoomError(null);
          setParticipantCount(message.participantCount);
          setMessages([]);
          setReactions([]);
          setRoomState(message);
          setLatestPlayerEvent({
            event: message.playbackState.status === "playing" ? "play" : "pause",
            timestamp: message.playbackState.timestamp
          });
        }

        if (message.type === "participant_update") {
          setParticipantCount(message.participantCount);
        }

        if (message.type === "player_event") {
          setLatestPlayerEvent({
            event: message.event,
            timestamp: message.timestamp
          });
        }

        if (message.type === "chat_message") {
          setMessages((current) => [...current, message]);
        }

        if (message.type === "reaction") {
          setReactions((current) => [...current, message]);
          const timer = window.setTimeout(() => {
            setReactions((current) => current.filter((reaction) => reaction.reactionId !== message.reactionId));
          }, 3200);
          reactionTimersRef.current.push(timer);
        }

        if (message.type === "room_error") {
          setRoomError(message);
        }
      });

      ws.addEventListener("close", () => {
        if (cancelled) {
          return;
        }

        const delay = Math.min(1000 * (2 ** retryRef.current), 30000);
        retryRef.current += 1;
        setStatus(roomIdRef.current ? "reconnecting" : "disconnected");
        retryTimer = window.setTimeout(connect, delay);
      });
    };

    connect();

    return () => {
      cancelled = true;
      window.clearTimeout(retryTimer);

      for (const timer of reactionTimersRef.current) {
        window.clearTimeout(timer);
      }

      reactionTimersRef.current = [];

      if (socketRef.current) {
        socketRef.current.close();
        socketRef.current = null;
      }
    };
  }, [enabled]);

  return {
    status,
    participantCount,
    messages,
    reactions,
    roomState,
    latestPlayerEvent,
    roomError,
    roomId: roomIdRef.current,
    currentUserName: userNameRef.current,
    sendPlayerEvent(payload) {
      if (socketRef.current?.readyState === WebSocket.OPEN) {
        socketRef.current.send(JSON.stringify({ type: "player_event", ...payload }));
      }
    },
    sendChatMessage(text) {
      if (socketRef.current?.readyState === WebSocket.OPEN) {
        socketRef.current.send(JSON.stringify({ type: "chat_message", text }));
      }
    },
    sendReaction(emoji) {
      if (socketRef.current?.readyState === WebSocket.OPEN) {
        socketRef.current.send(JSON.stringify({ type: "reaction", emoji }));
      }
    }
  };
}

function AppLink({ href, currentPath, navigate, children, className = "" }) {
  const isActive = href === "/" ? currentPath === "/" : currentPath.startsWith(href);
  const classes = `${className} ${isActive ? "is-active" : ""}`.trim();

  return (
    <a
      className={classes}
      href={href}
      onClick={(event) => {
        event.preventDefault();
        navigate(href);
      }}
    >
      {children}
    </a>
  );
}

function TopNav({ currentPath, navigate, onOpenJoinModal }) {
  return (
    <header className="topbar">
      <AppLink href="/" currentPath={currentPath} navigate={navigate} className="brand-mark">
        DuoFlix
      </AppLink>
      <nav className="topnav">
        {NAV_ITEMS.map((item) => (
          <AppLink key={item.href} href={item.href} currentPath={currentPath} navigate={navigate} className="nav-link">
            {item.label}
          </AppLink>
        ))}
      </nav>
      <button className="topbar-cta" onClick={onOpenJoinModal} type="button">
        Join room
      </button>
    </header>
  );
}

function MovieQuickStartModal({ movie, hostName, hostError, onHostNameChange, onClose, onSelectMode }) {
  if (!movie) {
    return null;
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card" onClick={(event) => event.stopPropagation()}>
        <p className="section-kicker">Quick start</p>
        <h2 className="modal-title">{movie.name}</h2>
        <p className="muted-copy">Open a solo screening immediately or create a live room from this title.</p>
        <div className="field-stack">
          <button className="ghost-button" onClick={() => onSelectMode("solo")}>Watch alone</button>
          <input
            value={hostName}
            onChange={(event) => onHostNameChange(event.target.value)}
            placeholder="Your name for the room"
          />
          <button onClick={() => onSelectMode("create")}>Create watch party</button>
          {hostError ? <p className="error-text">{hostError}</p> : null}
        </div>
      </div>
    </div>
  );
}

function RoomJoinModal({ joinName, joinRoomId, joinError, setJoinName, setJoinRoomId, onJoin, onClose }) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card" onClick={(event) => event.stopPropagation()}>
        <p className="section-kicker">Join room</p>
        <h2 className="modal-title">Enter a live screening</h2>
        <p className="muted-copy">Use the room ID from your host to restore sync, chat, and reactions instantly.</p>
        <div className="field-stack">
          <input
            value={joinName}
            onChange={(event) => {
              setJoinName(event.target.value);
            }}
            placeholder="Your name"
          />
          <input
            value={joinRoomId}
            onChange={(event) => {
              setJoinRoomId(event.target.value);
            }}
            placeholder="Room ID"
          />
          <button onClick={onJoin}>Join room</button>
          {joinError ? <p className="error-text">{joinError}</p> : null}
        </div>
      </div>
    </div>
  );
}

function ReactionTray({ reactions }) {
  const getReactionStyle = (reaction) => {
    const seed = Array.from(reaction.reactionId).reduce((total, char) => total + char.charCodeAt(0), 0);
    const driftX = ((seed % 17) - 8) * 4;
    const driftRotate = ((seed % 7) - 3) * 1.25;
    const delay = (seed % 5) * 0.03;

    return {
      "--drift-x": `${driftX}px`,
      "--drift-rotate": `${driftRotate}deg`,
      "--float-delay": `${delay}s`
    };
  };

  return (
    <div className="reaction-layer" aria-live="polite">
      {reactions.map((reaction) => (
        <div className="reaction-pill" key={reaction.reactionId} style={getReactionStyle(reaction)}>
          <span className="reaction-emoji">{reaction.emoji}</span>
          <span>{reaction.senderLabel}</span>
        </div>
      ))}
    </div>
  );
}

function ChatSidebar({ messages, currentUserName, onSend, onReact }) {
  const [text, setText] = useState("");
  const listRef = useRef(null);

  useEffect(() => {
    if (listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [messages]);

  return (
    <aside className="chat-sidebar">
      <div className="sidebar-block">
        <p className="section-kicker">Conversation</p>
        <h3 className="sidebar-title">Room chat</h3>
        <p className="sidebar-copy">Keep the room in sync without leaving the stream.</p>
      </div>

      <div className="reaction-row">
        {REACTION_OPTIONS.map((emoji) => (
          <button className="reaction-button" key={emoji} onClick={() => onReact(emoji)} type="button">
            {emoji}
          </button>
        ))}
      </div>

      <div className="chat-list" ref={listRef}>
        {messages.length === 0 ? (
          <div className="chat-empty">
            <p>No messages yet.</p>
            <span>Drop the first reaction or start the conversation.</span>
          </div>
        ) : (
          messages.map((message, index) => (
            <div
              className={`chat-item${message.senderLabel === currentUserName ? " is-own-message" : ""}`}
              key={`${message.senderId}-${message.receivedAt}-${index}`}
            >
              <strong>{message.senderLabel}</strong>
              <span>{message.text}</span>
            </div>
          ))
        )}
      </div>

      <form
        className="chat-form"
        onSubmit={(event) => {
          event.preventDefault();

          if (!text.trim()) {
            return;
          }

          onSend(text.trim());
          setText("");
        }}
      >
        <input value={text} onChange={(event) => setText(event.target.value)} placeholder="Send a message" />
        <button type="submit">Send</button>
      </form>
    </aside>
  );
}

function VideoPlayer({ src, mode, externalEvent, onPlayerEvent, onReact, reactions }) {
  const videoRef = useRef(null);
  const skipEmitRef = useRef(false);
  const shellRef = useRef(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [videoError, setVideoError] = useState("");
  const [isPlaying, setIsPlaying] = useState(false);
  const [isPlayerActive, setIsPlayerActive] = useState(false);

  useEffect(() => {
    setCurrentTime(0);
    setDuration(0);
    setVideoError("");
    setIsPlaying(false);
  }, [src]);

  useEffect(() => {
    if (!externalEvent || !videoRef.current) {
      return;
    }

    const video = videoRef.current;
    skipEmitRef.current = true;

    if (typeof externalEvent.timestamp === "number") {
      video.currentTime = externalEvent.timestamp;
      setCurrentTime(externalEvent.timestamp);
    }

    if (externalEvent.event === "play") {
      setIsPlaying(true);
      void video.play();
    }

    if (externalEvent.event === "pause") {
      setIsPlaying(false);
      video.pause();
    }

    skipEmitRef.current = false;
  }, [externalEvent]);

  const emit = (event, timestamp) => {
    if (mode !== "watch-party" || skipEmitRef.current || !onPlayerEvent) {
      return;
    }

    onPlayerEvent({ event, timestamp });
  };

  const seekTo = (value, eventName = "seek") => {
    if (!videoRef.current) {
      return;
    }

    const clamped = Math.max(0, Math.min(value, duration || value));
    videoRef.current.currentTime = clamped;
    setCurrentTime(clamped);
    emit(eventName, clamped);
  };

  const togglePlayback = () => {
    if (!videoRef.current) {
      return;
    }

    if (videoRef.current.paused) {
      void videoRef.current.play();
      return;
    }

    videoRef.current.pause();
  };

  return (
    <section className="player-shell">
      <div
        className={`player-stage${isPlayerActive ? " is-active" : ""}`}
        ref={shellRef}
        onMouseEnter={() => setIsPlayerActive(true)}
        onMouseLeave={() => setIsPlayerActive(false)}
        onFocus={() => setIsPlayerActive(true)}
        onBlur={(event) => {
          if (!shellRef.current?.contains(event.relatedTarget)) {
            setIsPlayerActive(false);
          }
        }}
      >
        <div className="video-wrap">
          <ReactionTray reactions={reactions} />
          <div className="video-overlay">
            <div className="video-badge">{mode === "watch-party" ? "Theater sync active" : "Private screening"}</div>
            <div className="video-fade" />
          </div>
          <div className="player-overlay-controls">
            <button
              className="overlay-control-button"
              onClick={() => seekTo((videoRef.current?.currentTime || 0) - 10, "backward")}
              type="button"
              aria-label="Go back 10 seconds"
            >
              <span className="overlay-icon"><BackwardIcon /></span>
              <span className="overlay-label">10</span>
            </button>
            <button
              className="overlay-control-button overlay-control-button-primary"
              onClick={togglePlayback}
              type="button"
              aria-label={isPlaying ? "Pause video" : "Play video"}
            >
              <span className="overlay-icon">{isPlaying ? <PauseIcon /> : <PlayIcon />}</span>
            </button>
            <button
              className="overlay-control-button"
              onClick={() => seekTo((videoRef.current?.currentTime || 0) + 10, "forward")}
              type="button"
              aria-label="Go forward 10 seconds"
            >
              <span className="overlay-icon"><ForwardIcon /></span>
              <span className="overlay-label">10</span>
            </button>
          </div>
          {videoError ? <div className="video-error">{videoError}</div> : null}
          <video
            ref={videoRef}
            src={src}
            controls={false}
            tabIndex={0}
            onClick={togglePlayback}
            onLoadedMetadata={(event) => setDuration(event.currentTarget.duration || 0)}
            onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)}
            onPlay={(event) => {
              setIsPlaying(true);
              emit("play", event.currentTarget.currentTime);
            }}
            onPause={(event) => {
              setIsPlaying(false);
              emit("pause", event.currentTarget.currentTime);
            }}
            onError={() => setVideoError("Could not load video.")}
          />
        </div>

        <div className="player-dock">
          <div className="player-progress-row">
            <span className="player-time">{formatTime(currentTime)}</span>
            <div className="timeline">
              <input
                type="range"
                min="0"
                max={duration || 0}
                step="0.1"
                value={Math.min(currentTime, duration || currentTime)}
                onChange={(event) => seekTo(Number(event.target.value))}
              />
            </div>
            <span className="player-time">{formatTime(duration)}</span>
          </div>

          <div className="controls">
            {mode === "watch-party" ? (
              <div className="player-reactions">
                <span className="player-reactions-label">React live</span>
                <div className="player-reactions-row">
                  {REACTION_OPTIONS.map((emoji) => (
                    <button
                      key={emoji}
                      className="player-reaction-chip"
                      onClick={() => onReact?.(emoji)}
                      type="button"
                    >
                      {emoji}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <div className="player-status-copy">
                <strong>Private viewing mode</strong>
                <span>A clean, local playback surface without room sync or chat.</span>
              </div>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

function PageHero({ title, copy, actions, aside }) {
  return (
    <section className={`hero hero-page${aside ? "" : " hero-page-single"}`}>
      <div className="hero-copy">
        <p className="section-kicker">DuoFlix</p>
        <h1>{title}</h1>
        <p className="muted-copy">{copy}</p>
        {actions}
      </div>
      {aside ? (
        <div className="hero-panel">
          {aside}
        </div>
      ) : null}
    </section>
  );
}

function MovieCard({ movie, onOpen, onQuickStart }) {
  return (
    <article className="movie-card">
      <button className="movie-thumb" onClick={() => onOpen(movie)} type="button">
        <span className="movie-thumb-mark">{movie.name.slice(0, 1).toUpperCase()}</span>
        <span className="movie-chip">Local file</span>
      </button>
      <div className="movie-card-body">
        <span className="movie-title">{movie.name}</span>
        <span className="movie-meta">Ready for solo play or a synced room</span>
      </div>
      <div className="movie-card-actions">
        <button className="ghost-button" onClick={() => onOpen(movie)} type="button">Details</button>
        <button onClick={() => onQuickStart(movie)} type="button">Quick start</button>
      </div>
    </article>
  );
}

function HomePage({ movies, navigate, onQuickStart, onOpenJoinModal }) {
  const spotlight = movies.slice(0, 3);
  const featuredMovie = spotlight[0];

  return (
    <>
      <PageHero
        title="Host a watch party that feels like a real screening room."
        copy="A sharper landing flow inspired by the Stitch watch-party screens: browse fast, enter rooms cleanly, and drop straight into synced playback."
        actions={(
          <div className="hero-actions">
            <AppLink href="/browse" currentPath="/" navigate={navigate} className="hero-link hero-link-primary">
              Browse movies
            </AppLink>
            <button className="hero-link hero-link-secondary" onClick={onOpenJoinModal} type="button">
              Join a room
            </button>
          </div>
        )}
        aside={(
          <div className="landing-panel">
            <div className="landing-panel-header">
              <p className="section-kicker">System view</p>
              <h3 className="sidebar-title">Built for private screenings and shared rooms.</h3>
            </div>
            <div className="landing-stat-row">
              {LANDING_STATS.map((item) => (
                <div className="landing-stat-card" key={item.label}>
                  <strong>{item.value}</strong>
                  <span>{item.label}</span>
                </div>
              ))}
            </div>
            <div className="info-stack">
              {FEATURE_POINTS.map((point, index) => (
                <div className="feature-card" key={point}>
                  <span className="feature-index">0{index + 1}</span>
                  <p>{point}</p>
                </div>
              ))}
            </div>
          </div>
        )}
      />

      <section className="page-section page-section-landing">
        <div className="section-head">
          <div>
            <p className="section-kicker">Featured flow</p>
            <h2 className="section-title">Start from a title, then branch into solo playback or a live room.</h2>
          </div>
          <button className="ghost-button" onClick={() => navigate("/browse")}>View full catalog</button>
        </div>
        <div className="landing-showcase">
          <div className="landing-feature">
            <div className="landing-feature-visual">
              <span className="movie-thumb-mark">{featuredMovie ? featuredMovie.name.slice(0, 1).toUpperCase() : "D"}</span>
              <span className="movie-chip">Featured title</span>
            </div>
            <div className="landing-feature-copy">
              <p className="section-kicker">Selected movie</p>
              <h3 className="sidebar-title">{featuredMovie?.name || "Your next screening"}</h3>
              <p className="muted-copy">Use the movie page for context, launch solo mode instantly, or create a synced room from the quick-start modal.</p>
              <div className="landing-feature-actions">
                {featuredMovie ? <button onClick={() => navigate(`/movie/${featuredMovie.id}`)}>Open movie page</button> : null}
                {featuredMovie ? <button className="ghost-button" onClick={() => onQuickStart(featuredMovie)}>Quick start</button> : null}
              </div>
            </div>
          </div>
          <div className="landing-rail">
            {spotlight.slice(1).map((movie) => (
              <button key={movie.id} className="landing-rail-item" onClick={() => navigate(`/movie/${movie.id}`)} type="button">
                <span className="landing-rail-mark">{movie.name.slice(0, 1).toUpperCase()}</span>
                <span>
                  <strong>{movie.name}</strong>
                  <small>Open details or create a room</small>
                </span>
              </button>
            ))}
          </div>
        </div>
        <div className="movie-grid movie-grid-compact">
          {spotlight.map((movie) => (
            <MovieCard key={movie.id} movie={movie} onOpen={() => navigate(`/movie/${movie.id}`)} onQuickStart={onQuickStart} />
          ))}
        </div>
      </section>
    </>
  );
}

function BrowsePage({ movies, loading, loadError, navigate, onQuickStart }) {
  return (
    <>
      <section className="page-section">
        {loadError ? <div className="banner error-banner">{loadError}</div> : null}
        {loading ? <div className="banner">Loading movies...</div> : null}
        {!loading && movies.length === 0 ? <div className="banner">No videos found in `backend/videos`.</div> : null}
        <div className="movie-grid">
          {movies.map((movie) => (
            <MovieCard key={movie.id} movie={movie} onOpen={() => navigate(`/movie/${movie.id}`)} onQuickStart={onQuickStart} />
          ))}
        </div>
      </section>
    </>
  );
}

function JoinPage({ joinName, joinRoomId, joinError, setJoinName, onJoin }) {
  return (
    <section className="page-section join-page">
      <div className="join-card">
        <h1 className="detail-title">Join room</h1>
        <div className="field-stack">
          <input value={joinRoomId} readOnly aria-label="Room ID" />
          <input
            value={joinName}
            onChange={(event) => setJoinName(event.target.value)}
            placeholder="Your name"
            aria-label="Your name"
          />
          <button onClick={onJoin}>Join now</button>
          {joinError ? <p className="error-text">{joinError}</p> : null}
        </div>
      </div>
    </section>
  );
}

function MovieDetailPage({ movie, navigate, onQuickStart, onOpenJoinModal }) {
  if (!movie) {
    return (
      <section className="page-section">
        <div className="banner error-banner">Movie not found.</div>
      </section>
    );
  }

  return (
    <section className="detail-shell">
      <div className="detail-poster">
        <span className="movie-thumb-mark">{movie.name.slice(0, 1).toUpperCase()}</span>
      </div>
      <div className="detail-copy">
        <p className="section-kicker">Movie detail</p>
        <h1 className="detail-title">{movie.name}</h1>
        <p className="muted-copy">Use this title as a private screening or the anchor for a shared room. This page mirrors the Stitch selection flow but gives the movie its own destination.</p>
        <div className="detail-actions">
          <button onClick={() => navigate(`/watch/solo/${movie.id}`)}>Start solo screening</button>
          <button className="ghost-button" onClick={() => onQuickStart(movie)}>Create or join via modal</button>
          <button className="ghost-button" onClick={onOpenJoinModal}>Join existing room</button>
        </div>
        <div className="detail-grid">
          <div className="info-card">
            <p className="section-kicker">Format</p>
            <strong>Local file playback</strong>
          </div>
          <div className="info-card">
            <p className="section-kicker">Modes</p>
            <strong>Solo and watch party</strong>
          </div>
          <div className="info-card">
            <p className="section-kicker">Actions</p>
            <strong>Create room, join room, chat live</strong>
          </div>
        </div>
      </div>
    </section>
  );
}

function SoloWatchPage({ movie, navigate }) {
  if (!movie) {
    return (
      <section className="page-section">
        <div className="banner error-banner">Movie not found.</div>
      </section>
    );
  }

  return (
    <section className="watch-layout">
      <div className="watch-main">
        <div className="room-banner">
          <div>
            <p className="section-kicker">Solo mode</p>
            <h2 className="section-title">{movie.name}</h2>
            <p className="room-copy">A distraction-free private screening with the same cinematic player layout.</p>
          </div>
          <button className="ghost-button" onClick={() => navigate(`/movie/${movie.id}`)}>Back to details</button>
        </div>
          <VideoPlayer src={`${API_BASE}${movie.url}`} mode="solo" reactions={[]} />
      </div>
    </section>
  );
}

function WatchPartyPage({ viewState, wsState, navigate, onCopyRoomId, onShareRoom, copyRoomLabel, shareRoomLabel }) {
  const connectionLabel = wsState.status === "connected"
    ? "Connected"
    : wsState.status === "reconnecting"
      ? "Reconnecting"
      : "Connecting";

  return (
    <section className="watch-layout">
      <div className="watch-main">
        <div className="room-banner">
          <div>
            <p className="section-kicker">Watch party</p>
            <h2 className="section-title">{viewState.movieName || "Loading room..."}</h2>
            <p className="room-copy">Room <strong>{viewState.roomId || "Connecting..."}</strong> · {wsState.participantCount} participants</p>
            <div className="room-meta-row">
              <span className="status-pill is-live">{connectionLabel}</span>
              <span className="meta-pill">Shared timeline</span>
              <span className="meta-pill">Realtime chat</span>
            </div>
          </div>
          <div className="room-actions">
            <button className="ghost-button" onClick={onCopyRoomId} type="button">{copyRoomLabel}</button>
            <button className="ghost-button" onClick={onShareRoom} type="button">{shareRoomLabel}</button>
            <button className="ghost-button" onClick={() => navigate("/")} type="button">Leave</button>
          </div>
        </div>
          <VideoPlayer
            src={viewState.movieUrl}
            mode="watch-party"
            externalEvent={wsState.latestPlayerEvent}
            onPlayerEvent={(payload) => wsState.sendPlayerEvent(payload)}
            onReact={(emoji) => wsState.sendReaction(emoji)}
            reactions={wsState.reactions}
          />
      </div>
      <ChatSidebar
        messages={wsState.messages}
        currentUserName={wsState.currentUserName}
        onSend={(text) => wsState.sendChatMessage(text)}
        onReact={(emoji) => wsState.sendReaction(emoji)}
      />
    </section>
  );
}

export default function App() {
  const { route, pathname, navigate } = useRouter();
  const [movies, setMovies] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [selectedMovie, setSelectedMovie] = useState(null);
  const [joinModalOpen, setJoinModalOpen] = useState(false);
  const [joinRoomId, setJoinRoomId] = useState("");
  const [joinName, setJoinName] = useState("");
  const [joinError, setJoinError] = useState("");
  const [hostName, setHostName] = useState("");
  const [hostError, setHostError] = useState("");
  const [copyRoomLabel, setCopyRoomLabel] = useState("Copy room ID");
  const [shareRoomLabel, setShareRoomLabel] = useState("Share");
  const [watchPartyView, setWatchPartyView] = useState({
    pendingAction: null,
    movieId: "",
    movieName: "",
    movieUrl: "",
    roomId: ""
  });

  useEffect(() => {
    if (route.page === "join" && route.roomId) {
      setJoinRoomId(route.roomId);
      setJoinError("");
      setJoinModalOpen(false);
    }
  }, [route.page, route.roomId]);

  useEffect(() => {
    const loadMovies = async () => {
      try {
        const response = await fetch(`${API_BASE}/api/movies`);

        if (!response.ok) {
          throw new Error("Failed to load movies");
        }

        setMovies(await response.json());
      } catch (error) {
        setLoadError("Could not load movies. Please refresh.");
      } finally {
        setLoading(false);
      }
    };

    void loadMovies();
  }, []);

  const wsState = useWatchParty({
    enabled: route.page === "watch-party",
    pendingAction: watchPartyView.pendingAction
  });

  useEffect(() => {
    if (!wsState.roomState) {
      return;
    }

    setWatchPartyView((current) => ({
      ...current,
      roomId: wsState.roomState.roomId,
      movieId: wsState.roomState.movieId,
      movieName: wsState.roomState.movieName,
      movieUrl: `${API_BASE}${wsState.roomState.movieUrl}`,
      pendingAction: null
    }));
  }, [wsState.roomState]);

  useEffect(() => {
    if (!wsState.roomError) {
      return;
    }

    if (wsState.roomError.code === "ROOM_NOT_FOUND") {
      setJoinError("Room not found. Check the Room ID and try again.");
      setJoinModalOpen(true);
      navigate("/");
      return;
    }

    if (wsState.roomError.code === "INVALID_PAYLOAD") {
      setJoinError(wsState.roomError.message);
      setHostError(wsState.roomError.message);
      setJoinModalOpen(true);
      navigate("/");
    }
  }, [wsState.roomError]);

  const moviesById = useMemo(
    () => new Map(movies.map((movie) => [String(movie.id), movie])),
    [movies]
  );

  const currentMovie = route.movieId ? moviesById.get(String(route.movieId)) : null;

  const openQuickStart = (movie) => {
    setSelectedMovie(movie);
    setHostName("");
    setHostError("");
  };

  const joinRoom = () => {
    setJoinError("");

    if (!joinName.trim()) {
      setJoinError("Your name is required.");
      return;
    }

    if (!joinRoomId.trim()) {
      setJoinError("Room ID is required.");
      return;
    }

    setJoinModalOpen(false);
    setWatchPartyView({
      pendingAction: {
        type: "join",
        roomId: joinRoomId.trim(),
        userName: joinName.trim()
      },
      movieId: "",
      movieName: "",
      movieUrl: "",
      roomId: joinRoomId.trim()
    });
    navigate("/watch/party");
  };

  const copyText = async (value) => {
    if (!value) {
      return;
    }

    try {
      await navigator.clipboard.writeText(value);
    } catch {
      const helper = document.createElement("textarea");
      helper.value = value;
      helper.setAttribute("readonly", "");
      helper.style.position = "absolute";
      helper.style.left = "-9999px";
      document.body.appendChild(helper);
      helper.select();
      document.execCommand("copy");
      document.body.removeChild(helper);
    }
  };

  const shareRoomUrl = watchPartyView.roomId
    ? `${window.location.origin}/join?room=${encodeURIComponent(watchPartyView.roomId)}`
    : "";

  const flashLabel = (setter, idleText, activeText) => {
    setter(activeText);
    window.setTimeout(() => {
      setter(idleText);
    }, 1600);
  };

  const startQuickAction = (mode) => {
    if (!selectedMovie) {
      return;
    }

    if (mode === "solo") {
      navigate(`/watch/solo/${selectedMovie.id}`);
      setSelectedMovie(null);
      return;
    }

    if (!hostName.trim()) {
      setHostError("Your name is required to create a room.");
      return;
    }

    setWatchPartyView({
      pendingAction: {
        type: "create",
        movieId: selectedMovie.id,
        userName: hostName.trim()
      },
      movieId: selectedMovie.id,
      movieName: selectedMovie.name,
      movieUrl: `${API_BASE}${selectedMovie.url}`,
      roomId: ""
    });
    setSelectedMovie(null);
    navigate("/watch/party");
  };

  return (
    <main className="app-shell">
      <TopNav
        currentPath={pathname}
        navigate={navigate}
        onOpenJoinModal={() => {
          setJoinError("");
          setJoinModalOpen(true);
        }}
      />
      <div className="content-shell">
        {route.page === "home" ? (
          <HomePage
            movies={movies}
            navigate={navigate}
            onQuickStart={openQuickStart}
            onOpenJoinModal={() => {
              setJoinError("");
              setJoinModalOpen(true);
            }}
          />
        ) : null}

        {route.page === "browse" ? (
          <BrowsePage
            movies={movies}
            loading={loading}
            loadError={loadError}
            navigate={navigate}
            onQuickStart={openQuickStart}
          />
        ) : null}

        {route.page === "join" ? (
          <JoinPage
            joinName={joinName}
            joinRoomId={joinRoomId}
            joinError={joinError}
            setJoinName={(value) => {
              setJoinName(value);
              setJoinError("");
            }}
            onJoin={joinRoom}
          />
        ) : null}

        {route.page === "movie" ? (
          <MovieDetailPage
            movie={currentMovie}
            navigate={navigate}
            onQuickStart={openQuickStart}
            onOpenJoinModal={() => {
              setJoinError("");
              setJoinModalOpen(true);
            }}
          />
        ) : null}

        {route.page === "solo" ? (
          <SoloWatchPage movie={currentMovie} navigate={navigate} />
        ) : null}

        {route.page === "watch-party" ? (
          <WatchPartyPage
            viewState={watchPartyView}
            wsState={wsState}
            navigate={navigate}
            onCopyRoomId={async () => {
              await copyText(watchPartyView.roomId);
              flashLabel(setCopyRoomLabel, "Copy room ID", "Copied");
            }}
            onShareRoom={async () => {
              await copyText(shareRoomUrl);
              flashLabel(setShareRoomLabel, "Share", "Copied");
            }}
            copyRoomLabel={copyRoomLabel}
            shareRoomLabel={shareRoomLabel}
          />
        ) : null}

        {route.page === "not-found" ? (
          <section className="page-section">
            <div className="banner error-banner">Page not found.</div>
          </section>
        ) : null}
      </div>

      <MovieQuickStartModal
        movie={selectedMovie}
        hostName={hostName}
        hostError={hostError}
        onHostNameChange={(value) => {
          setHostName(value);
          setHostError("");
        }}
        onClose={() => setSelectedMovie(null)}
        onSelectMode={startQuickAction}
      />

      {joinModalOpen ? (
        <RoomJoinModal
          joinName={joinName}
          joinRoomId={joinRoomId}
          joinError={joinError}
          setJoinName={(value) => {
            setJoinName(value);
            setJoinError("");
          }}
          setJoinRoomId={(value) => {
            setJoinRoomId(value);
            setJoinError("");
          }}
          onJoin={joinRoom}
          onClose={() => setJoinModalOpen(false)}
        />
      ) : null}
    </main>
  );
}
