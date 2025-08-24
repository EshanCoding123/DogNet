# DogNet

RUNS ON -> https://dognet-355943195243.us-east4.run.app

HELLO EVERYONE + ANIMAL HACKS COMMITEE!

My name is Eshan and I am a high school student. I have designed a web-application called "DogNet". This app works in conjunction with my own IoT dog GPS. My idea with this app was to create a "dog network" of sorts, where you could see your own dogs through GPS trackers and other owner's dogs. I also wanted to mainly show the characteristics of each dog on the map, so that people are aware of whether dogs are friendly or not. This can prevent a lot of bad interactions between dog owners who have unfriendly dogs and unsuspecting people. It can also show other people if their dog is a service animal and highlight any other important information.

Here are the key features:
- GPS device is assigned a unique ID that must be entered on registration for dog
- Dogs can be registered, removed, edited, and deleted
- Dogs can be displayed publicly to other owners (this shows whether owners should approach the dog or stay away from them)
- Dogs can also be displayed solely to the owner by turning off a checkbox in the dog registration
- Public location of your dog is not shown when you are in your house for privacy
- MongoDB Atlas stores login and account info along with each dog and each location/public location

For the GPS, it is very primitive but uses a SIM7000 chip attached to an arduino board to post location information with a specific pre-assigned DEVICE_ID for the registered dog. IT IS VERY CRITICAL NOT TO SHARE YOUR DEVICE_ID WITH ANYONE. 




