# Security policy

## Supported versions

Only the latest version published on the Chrome Web Store receives fixes.

## Reporting a vulnerability

Please don't report security problems in a public issue.

Use the **Report a vulnerability** button in the [Security tab](https://github.com/Balrog994/bandwise-eq/security) of this repository. The report stays private between you and me until a fix is out. If you can't use GitHub, write to bandwise@ilbalrog.it.

Please include what you found, how to reproduce it and which version of Bandwise EQ and Chrome you used.

This is a project I maintain in my spare time: I try to reply within a week, and I'll keep you updated until the problem is fixed. If you like, I'll credit you in the release notes.

## What counts as a security problem

Some examples of what I'd like to hear about:

- the extension capturing audio from a tab without the user turning it on;
- any way for a web page to read or change the extension's settings, or to talk to the extension;
- a preset or Equalizer APO file that, when imported, runs code or breaks the extension;
- anything that sends data off the user's computer.

Chrome showing that a tab's audio is being captured while the EQ is on is expected behavior, not a vulnerability.
