Channel.prototype.getNowNext = function (callback) {
  var self = this;
  if (self.contentGuideURI) {
    NetworkRequest(self.contentGuideURI + "?sid=" + self.getServiceRef() + "&now_next=true", {
      success: function (data) {
        var now_next = {};
        var newPrograms = self.parseSchedule(data);
        if (newPrograms.length > 0) {
          var program = new Program(newPrograms[0], this.element_id + "_program_" + 0, self);
          program.bilingual = this.bilingual;
          program.channelimage = this.image;
          program.channel_streamurl = this.streamurl;
          now_next["now"] = program;
        }
        if (newPrograms.length > 1) {
          var program = new Program(newPrograms[1], this.element_id + "_program_" + 0, self);
          program.bilingual = this.bilingual;
          program.channelimage = this.image;
          program.channel_streamurl = this.streamurl;
          now_next["next"] = program;
        }
        self.now_next = now_next;
        if (typeof callback == "function") {
          callback.call();
        }
      },
      dataType: "text",
    });
  }
};

Channel.prototype.getSchedule = function (callback) {
  var self = this;
  self.programs = [];

  if (self.contentGuideURI) {
    NetworkRequest(
      self.contentGuideURI + "?sid=" + self.getServiceRef() + "&start=" + self.epg.start + "&end=" + self.epg.end,
      {
        success: function (data) {
          var programData = self.parseSchedule(data);
          self.programs = [];
          for (var i = 0; i < programData.length; i++) {
            var program2 = new Program(programData[i], this.element_id + "_program_" + i, self);
            program2.bilingual = this.bilingual;
            program2.channelimage = this.image;
            program2.channel_streamurl = this.streamurl;
            self.programs.push(program2);
          }
          if (typeof callback == "function") {
            callback.call();
          }
        },
        dataType: "text",
      }
    );
  }
};

Channel.prototype.init = function (init_obj, channel_index) {
  this.center = 1;
  this.open = false;
  this.element_id = channel_index;
  this.selected = false;
  var self = this;
  $.each(init_obj, function (f, field) {
    self[f] = field;
  });
  self.getNowNext();
  self.element = document.getElementById("channel_" + channel_index);
  if (self.element == null) {
    var newTextbox = document.createElement("a");
    newTextbox.href = "javascript:channelSelected('" + self.id + "')";
    newTextbox.classList.add("d-flex");
    var span1 = document.createElement("span");
    span1.classList.add("chicon", "pl-1", "order-3");
    var img = document.createElement("img");
    img.src = getImageSrc(self.image);
    span1.appendChild(img);
    newTextbox.appendChild(span1);
    var span = document.createElement("span");
    span.classList.add("chnumber", "px-1");
    span.appendChild(document.createTextNode(self.lcn));
    newTextbox.appendChild(span);
    span = document.createElement("span");
    span.classList.add("chname", "text-truncate");
    span.appendChild(document.createTextNode(getLocalizedText(self.titles, language_settings.ui_language)));
    newTextbox.appendChild(span);
    var li = document.createElement("li");
    li.classList.add("list-group-item");
    li.id = "channel_" + channel_index;
    var container = document.createElement("div");
    var ranking = this.getRanking();
    if (ranking) {
      if (ranking === true) {
        newTextbox.classList.add("ranking_none");
      } else if (ranking <= 10) {
        newTextbox.classList.add("ranking_" + ranking);
      } else if (ranking <= 100) {
        newTextbox.classList.add("ranking_100");
      } else if (ranking <= 1000) {
        newTextbox.classList.add("ranking_1000");
      } else {
        newTextbox.classList.add("ranking_10000");
      }
    }
    container.classList.add("d-flex", "justify-content-end");
    container.appendChild(newTextbox);
    if (this.serviceInstances.length == 0) {
      container.classList.add("unavailable");
    }
    li.appendChild(container);
    self.element = li;
  }
};

Channel.prototype.languageChanged = function () {
  var chname = this.element.getElementsByClassName("chname")[0];
  chname.innerHTML = "";
  chname.appendChild(document.createTextNode(getLocalizedText(this.titles, language_settings.ui_language)));
  if (this.selected) {
    document.getElementsByClassName("menuitem_chname")[0].innerHTML = getLocalizedText(
      this.titles,
      language_settings.ui_language
    );
  }
  this.epg_element = null;
  if (this.programs) {
    for (var i = 0; i < this.programs.length; i++) {
      this.programs[i].element = null;
    }
  }
};

Channel.prototype.unselected = function () {
  var self = this;
  if (self.availablityTimer) {
    clearInterval(self.availablityTimer);
    self.availablityTimer = null;
  }
  self.selected = false;
  self.element.classList.remove("active");
  player.attachSource(null);
  // The application is bound to this service; it goes when the service does.
  hideLinkedApp();
};

Channel.prototype.getMediaPresentationApp = function (serviceInstance) {
  var self = this,
    i,
    mediaPresentationApp;
  if (serviceInstance && serviceInstance.mediaPresentationApps) {
    for (i = 0; i < serviceInstance.mediaPresentationApps.length; i++) {
      mediaPresentationApp = serviceInstance.mediaPresentationApps[i];
      if (mediaPresentationApp.contentType == XML_MIME || mediaPresentationApp.contentType == XHTML_MIME) {
        return mediaPresentationApp.url;
      }
    }
  }
  if (self.mediaPresentationApps) {
    for (i = 0; i < self.mediaPresentationApps.length; i++) {
      mediaPresentationApp = self.mediaPresentationApps[i];
      if (mediaPresentationApp.contentType == XML_MIME || mediaPresentationApp.contentType == XHTML_MIME) {
        return mediaPresentationApp.url;
      }
    }
  }
  return null;
};

// ── Linked applications, type 1.1 ("app with media in parallel") ────────────
//
// The client previously handled only type 1.2, which takes over the screen.
// Type 1.1 apps are meant to run *alongside* the client's own playback, which is
// how DVB-I signals an accessibility overlay such as a sign-language interpreter
// (see A177 clause 5.2.3 and TS 102 796 annex O, where these are equivalent to
// ordinary broadcast-related applications). The client therefore keeps
// presenting the service and hosts the application above its own video.

Channel.prototype.getParallelApp = function (serviceInstance) {
  var self = this,
    lists = [serviceInstance && serviceInstance.parallelApps, self.parallelApps],
    l, i, app;
  for (l = 0; l < lists.length; l++) {
    if (!lists[l]) continue;
    for (i = 0; i < lists[l].length; i++) {
      app = lists[l][i];
      if (
        app.contentType == AIT_MIME ||
        app.contentType == XHTML_MIME ||
        app.contentType == XML_MIME ||
        app.contentType == "text/html"
      ) {
        return app;
      }
    }
  }
  return null;
};

// Namespace prefixes vary between AIT authors, so match on local name.
function firstByLocalName(doc, name) {
  var all = doc.getElementsByTagName("*"),
    i;
  for (i = 0; i < all.length; i++) {
    if (all[i].localName == name) return all[i];
  }
  return null;
}

// An ait+xml MediaUri points at an XML AIT describing the application, not at
// the application itself (A177 table 7). Resolve it to a launchable URL.
function resolveLinkedAppUrl(app, callback) {
  if (app.contentType != AIT_MIME) {
    callback(app.url);
    return;
  }
  fetch(app.url)
    .then(function (r) {
      return r.text();
    })
    .then(function (xml) {
      var doc = new DOMParser().parseFromString(xml, "application/xml");
      var base = firstByLocalName(doc, "URLBase");
      var loc = firstByLocalName(doc, "applicationLocation");
      if (!base || !loc) throw new Error("XML AIT has no URLBase/applicationLocation");
      callback(base.textContent.trim() + loc.textContent.trim());
    })
    .catch(function (e) {
      console.log("Linked application could not be resolved: " + e.message);
    });
}

function showLinkedApp(url) {
  var frame = document.getElementById("linked_app");
  if (!frame) {
    frame = document.createElement("iframe");
    frame.id = "linked_app";
    frame.setAttribute("allowtransparency", "true");
    frame.style.cssText =
      "position:fixed;left:0;top:0;width:100%;height:100%;border:0;background:transparent;z-index:5";
    document.body.appendChild(frame);
  }
  if (frame.getAttribute("src") != url) frame.setAttribute("src", url);
  frame.style.display = "block";

  // Giving the application focus means keys stop arriving at this document, so
  // the client has to re-assert the ones it owns inside the application's own.
  // Bound on load because each load is a new document, and again right away for
  // the case where the frame is only being re-shown and load will not fire.
  if (typeof bindRemoteToLinkedApp == "function") {
    frame.onload = function () {
      bindRemoteToLinkedApp(frame);
    };
    bindRemoteToLinkedApp(frame);
  }

  // The application handles the colour keys itself, so give it the focus.
  try {
    frame.contentWindow.focus();
  } catch (e) {}
}

function hideLinkedApp() {
  var frame = document.getElementById("linked_app");
  if (frame) {
    frame.style.display = "none";
    frame.setAttribute("src", "about:blank");
  }
}

// Seconds behind the live edge to hold playback.
//
// Two independent reasons arrive at the same number.
//
// An accessibility overlay decodes the signer in software from segments that
// are already published, so it can only follow a picture that is not sitting on
// the live edge. A few seconds of latency buys an overlay that can stay
// aligned; without it the two can never meet. That is why this matches
// LIVE_DELAY_SEC in the application.
//
// The encoder also does not publish on a metronome. Intervals between the
// manifest's publishTime values were measured at 3.7 s to 5.5 s against a
// nominal 4 s, with periodic 8 s gaps where two segments appear at once — the
// host runs two live x264 encodes, so ffmpeg falls behind and catches up in
// bursts. The manifest advertises suggestedPresentationDelay of one segment,
// which leaves a client no headroom for a burst at all.
//
// The second reason applies to every service, not only to those carrying an
// application, so the delay is no longer conditional on one being present:
// holding it back only for the overlay left the plain live services stalling on
// exactly the bursts the overlay was protected from.
var LIVE_DELAY_SEC = 12;

Channel.prototype.applyLiveDelay = function () {
  try {
    // Nested under delay, not a flat streaming.liveDelay: dash.js v5 moved it
    // there and warns on the old spelling for every service change.
    player.updateSettings({
      streaming: {
        delay: { liveDelay: LIVE_DELAY_SEC },
      },
    });
  } catch (e) {
    console.log("Could not set live delay: " + e.message);
  }
};

Channel.prototype.startParallelApp = function () {
  var app = this.getParallelApp(this.serviceInstance);
  if (!app) {
    hideLinkedApp();
    return;
  }
  resolveLinkedAppUrl(app, showLinkedApp);
};

Channel.prototype.checkAvailability = function () {
  var instance = this.getServiceInstance();
  if (instance != this.serviceInstance) {
    console.log("different service instace, select service");
    this.channelSelected();
  }
  this.availablityTimer = setTimeout(this.checkAvailability.bind(this), 60 * 1000);
};

function UUIDv7() {
  // see https://stackoverflow.com/questions/71816194/uuidv6-v7-v8-in-javascript-browser
  return "tttttttt-tttt-7xxx-yxxx-xxxxxxxxxxxx"
    .replace(/[xy]/g, function (c) {
      const r = Math.trunc(Math.random() * 16);
      const v = c == "x" ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    })
    .replace(/^[t]{8}-[t]{4}/, function () {
      const unixtimestamp = Date.now().toString(16).padStart(12, "0");
      return unixtimestamp.slice(0, 8) + "-" + unixtimestamp.slice(8);
    });
}

function DASHjsVersion5(player) {
  var [major, minor, micro] = player.getVersion().split(".");
  return major >= 5;
}

function playDASH(player, instance) {
  if (instance == null) {
    player.updateSettings({ streaming: { cmcd: { enabled: false } } });
    player.attachSource(null);
    return;
  }

  if (instance.hasOwnProperty("CMCDinit") && instance.CMCDinit != null) {
    var cmcd_vars = { ...instance.CMCDinit };
    cmcd_vars.sid = UUIDv7();
    if (DASHjsVersion5(player)) {
      cmcd_vars.applyParametersFromMpd = false;
      cmcd_vars.includeInRequests = ["segment", "mpd"];
    } else {
      delete cmcd_vars.version;
    }
    player.updateSettings({
      streaming: { cmcd: cmcd_vars },
    });
  } else {
    player.updateSettings({ streaming: { cmcd: { enabled: false } } });
  }
  player.attachSource(instance.dashUrl);
}

Channel.prototype.channelSelected = function () {
  var self = this;
  $("#notification").hide();
  self.element.classList.add("active");
  self.selected = true;
  var update = function () {
    self.serviceInstance = self.getServiceInstance();
    if (self.availablityTimer) {
      clearInterval(self.availablityTimer);
    }
    if (self.hasAvailability()) {
      self.availablityTimer = setTimeout(self.checkAvailability.bind(self), (60 - new Date().getSeconds()) * 1000);
    }
    if (self.serviceInstance == null) {
      $("#notification").show();
      $("#notification").removeClass();
      $("#notification").addClass("noservice");
      if (self.out_of_service_image) {
        $("#notification").html(
          '<img src="' + getImageSrc(self.out_of_service_image) + '" class="img-fluid position-relative"/>'
        );
      } else {
        $("#notification").text("Service not available");
      }
    }
    self.setProgramChangedTimer();
    self.updateChannelInfo();
    var mediaPresentationApp = self.getMediaPresentationApp(self.serviceInstance);
    if (mediaPresentationApp) {
      window.location = mediaPresentationApp;
    } else if (self.isProgramAllowed()) {
      $("#parentalpin").hide();
      if (self.serviceInstance) {
        // Set before attaching the source, so the delay applies from the start.
        self.applyLiveDelay();
        playDASH(player, self.serviceInstance);
      }
      // Started after playback, in parallel with it — the client keeps the
      // picture and the application contributes only its overlay.
      self.startParallelApp();
    } else {
      playDASH(player, null);
      checkParentalPIN(
        "Enter parental PIN to watch service",
        function () {
          $("#notification").hide();
          try {
            if (player.getSource() != self.serviceInstance.dashUrl) {
              playDASH(player, self.serviceInstance);
            }
          } catch (e) {
            //player throws an error is there is no souce attached
            playDASH(player, self.serviceInstance);
          }
        },
        function () {
          $("#notification").show();
          $("#notification").removeClass();
          $("#notification").text(i18n.getString("parental_block"));
        }
      );
    }
  };
  if (self.nowNextUpdateRequired()) {
    self.getNowNext(update);
  } else {
    update.call();
  }
};

Channel.prototype.programChanged = function () {
  var self = this;
  var update = function () {
    self.updateChannelInfo();
    var serviceInstance = self.getServiceInstance();
    if (self.isProgramAllowed()) {
      $("#parentalpin").hide();
      $("#notification").hide();
      try {
        if (player.getSource() != serviceInstance.dashUrl) {
          playDASH(player, serviceInstance);
        }
      } catch (e) {
        //player throws an error is there is no souce attached
        playDASH(player, serviceInstance);
      }
    } else {
      player.attachSource(null);
      checkParentalPIN(
        "Enter parental PIN to watch service",
        function () {
          $("#notification").hide();
          try {
            if (player.getSource() != serviceInstance.dashUrl) {
              playDASH(player, serviceInstance);
            }
          } catch (e) {
            //player throws an error is there is no souce attached
            playDASH(player, serviceInstance);
          }
        },
        function () {
          $("#notification").show();
          $("#notification").removeClass();
          $("#notification").text(i18n.getString("parental_block"));
        }
      );
    }
    self.setProgramChangedTimer();
  };
  self.getNowNext(update);
};

Channel.prototype.setProgramChangedTimer = function () {
  var self = this;
  if (programChangeTimer) {
    clearTimeout(programChangeTimer);
  }
  if (self.now_next) {
    curTime = new Date();
    var now = self.now_next["now"];
    if (now) {
      if (curTime < now.end) {
        programChangeTimer = setTimeout(self.programChanged.bind(self), now.end - curTime);
      }
    }
  }
};

Channel.prototype.nowNextUpdateRequired = function () {
  var self = this;
  if (!self.contentGuideURI) {
    return false;
  }
  if (self.now_next) {
    curTime = new Date();
    var now = self.now_next["now"];
    if (now) {
      if (curTime < now.end) {
        return false;
      }
    }
  }
  return true;
};

Channel.prototype.updateChannelInfo = function () {
  var self = this,
    i,
    parental,
    info,
    cpsInstance;
  var channelInfo = $("#channel_info");
  channelInfo.empty();
  channelInfo.append('<span class="menuitem_chicon d-inline-block"><img src="' + getImageSrc(self.image) + '"></span>');
  channelInfo.append(
    '<span class="menuitem_chnumber d-inline-block">' +
      self.lcn +
      '.</span><span class="menuitem_chname d-inline-block">' +
      getLocalizedText(this.titles, language_settings.ui_language) +
      "</span>"
  );
  if (self.provider) {
    channelInfo.append('<br/><span class="menuitem_provider d-inline-block col-12 px-0">' + self.provider + "</span>");
  }
  if (self.now_next) {
    curTime = new Date();
    var now = self.now_next["now"];
    if (now) {
      parental = "";
      if (now.parentalRating && now.parentalRating.length > 0) {
        for (i = 0; i < now.parentalRating.length; i++) {
          if (now.parentalRating[i].minimumage) {
            parental = "(" + now.parentalRating[i].minimumage + ")";
            break;
          }
        }
      }
      info = $(
        '<span class="menuitem_now d-inline-block col-auto px-0">Now: ' +
          now.getTitle() +
          parental +
          " " +
          Math.max(0, Math.round((now.end.getTime() - curTime.getTime()) / 1000 / 60)) +
          " mins remaining</span>"
      );
      channelInfo.append(info);
      if (now.cpsIndex) {
        cpsInstance = this.getServiceInstanceByCPSIndex(now.cpsIndex);
        if (cpsInstance) {
          channelInfo.append(
            '<span class="chdrm d-inline-block col-2 px-2"><img src="images/lock.svg" class="icon-green"></span>'
          );
        } else {
          channelInfo.append(
            '<span class="chdrm d-inline-block col-2 px-2"><img src="images/lock.svg" class="icon-red"></span>'
          );
        }
      }
      info.click(function () {
        openProgramInfo(now);
      });
    }
    var next = self.now_next["next"];
    if (next) {
      parental = "";
      if (next.parentalRating && next.parentalRating.length > 0) {
        for (i = 0; i < next.parentalRating.length; i++) {
          if (next.parentalRating[i].minimumage) {
            parental = "(" + next.parentalRating[i].minimumage + ")";
            break;
          }
        }
      }
      info = $(
        '<br/><span class="menuitem_next d-inline-block col-auto px-0">Next: ' +
          next.getTitle() +
          parental +
          " " +
          next.start.create24HourTimeString() +
          " Duration " +
          Math.max(0, Math.round((next.end.getTime() - next.start.getTime()) / 1000 / 60)) +
          " mins</span>"
      );
      channelInfo.append(info);
      if (next.cpsIndex) {
        cpsInstance = this.getServiceInstanceByCPSIndex(next.cpsIndex);
        if (cpsInstance) {
          channelInfo.append(
            '<span class="chdrm d-inline-block col-2 px-2"><img src="images/lock.svg" class="icon-green"></span>'
          );
        } else {
          channelInfo.append(
            '<span class="chdrm d-inline-block col-2 px-2"><img src="images/lock.svg" class="icon-red"></span>'
          );
        }
      }
      info.click(function () {
        openProgramInfo(next);
      });
    }
  }
  if (self.accessibility_attributes) {
    channelInfo.append(
      '<br/><span class="menuitem_accessibility d-inline-block col-auto px-0">' +
        formatAccessibilityAttributes(self.accessibility_attributes) +
        "</span>"
    );
  }
};

Channel.prototype.showEPG = function () {
  var self = this;
  var programList = null;
  if (self.epg_element == null) {
    var element = document.createElement("div");
    element.addClass("channelCol col-4 mx-0 px-0");
    if (selectedChannel == this) {
      element.addClass("selected");
    }
    var header = document.createElement("div");
    header.addClass("epg_chinfo align-items-center sticky-top px-2");
    var logo = document.createElement("img");
    logo.setAttribute("src", getImageSrc(self?.image));
    logo.setAttribute("alt", "channel icon");
    logo.addClass("chicon img-fluid d-block");
    header.appendChild(logo);
    var number = document.createElement("span");
    number.addClass("chnumber d-inline-block float-left");
    number.innerHTML = self.lcn;
    header.appendChild(number);
    var name = document.createElement("span");
    name.addClass("chname text-truncate d-inline-block");
    name.innerHTML = getLocalizedText(self.titles, language_settings.ui_language);
    header.appendChild(name);
    element.appendChild(header);
    this.programList = document.createElement("ul");
    this.programList.addClass("list list-group-flush list-programs container-fluid");
    element.appendChild(this.programList);
    self.epg_element = element;
  } else {
    $(this.programList).empty();
  }
  if (!self.programs) {
    this.getSchedule(self.populateEPG.bind(self));
  } else {
    this.populateEPG();
  }
  return self.epg_element;
};

Channel.prototype.populateEPG = function () {
  var self = this;
  if (self.programs) {
    for (var i = 0; i < self.programs.length; i++) {
      this.programList.appendChild(self.programs[i].populate());
    }
  }
};

//Called when user changes parental rating in the settings
//Program information should be up to date, updated with the programChangeTimer
Channel.prototype.parentalRatingChanged = function (callback) {
  var self = this;
  var serviceInstance = self.getServiceInstance();
  if (self.isProgramAllowed()) {
    $("#parentalpin").hide();
    $("#notification").hide();
    try {
      if (player.getSource() != serviceInstance.dashUrl) {
        playDASH(player, serviceInstance);
      }
    } catch (e) {
      //player throws an error if there is no souce attached
      playDASH(player, serviceInstance);
    }
  } else {
    player.attachSource(null);
    checkParentalPIN(
      "Enter parental PIN to watch service",
      function () {
        $("#notification").hide();
        try {
          if (player.getSource() != serviceInstance.dashUrl) {
            playDASH(player, serviceInstance);
          }
        } catch (e) {
          //player throws an error is there is no souce attached
          playDASH(player, serviceInstance);
        }
      },
      function () {
        $("#notification").show();
        $("#notification").removeClass();
        $("#notification").text(i18n.getString("parental_block"));
      }
    );
  }
};

Channel.prototype.isProgramAllowed = function () {
  if (parentalEnabled && this.now_next) {
    var now = this.now_next["now"];
    if (now && now.parentalRating && now.parentalRating.length > 0) {
      for (var i = 0; i < now.parentalRating.length; i++) {
        if (now.parentalRating[i].minimumage && minimumAge < now.parentalRating[i].minimumage) {
          return false;
        }
      }
    }
  }
  return true;
};
